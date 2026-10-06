#!/usr/bin/env python3
"""Sourcery security gate for CI.

Fails (exit 1) when ACTIVE findings in the given Sourcery repositories match
the failing severities/types. Read-only: it never mutates triage state.

Auth: SOURCERY_API_KEY environment variable (set as a repo secret in CI,
never hardcoded). Keys live at https://app.sourcery.ai/dashboard/api-keys

Usage:
  python sourcery_gate.py --repos "Stronghold-Protocol" \
      --fail-types SECRET,DEPENDENCY --fail-severities CRITICAL,HIGH

  # Rename-proof (preferred in workflows): the repository id is the stable anchor; the name
  # is only a cross-check when it still resolves.
  python sourcery_gate.py --repos "$GITHUB_REPO_NAME" --repo-ids 1402031064 ...
"""

import argparse
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.sourcery.ai/api/v1"
API_HOST = "api.sourcery.ai"
ISSUE_TYPES = ["SECRET", "SAST", "IAC", "DEPENDENCY", "LICENSE"]
SEVERITIES = ["NO_RISK", "LOW", "MEDIUM", "HIGH", "CRITICAL"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Block redirects so a response can never bounce the client to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(NoRedirect)


def api(path, key):
    url = urllib.parse.urlparse(BASE + path)
    if url.scheme != "https" or url.hostname != API_HOST:
        # fixed allowlist: scheme + exact host; the TLS cert check then pins
        # the server identity, so DNS tricks cannot reroute the request
        sys.exit("blocked non-allowlisted URL: %s" % url.geturl())
    req = urllib.request.Request(url.geturl(), headers={"Authorization": "Bearer " + key})
    try:
        with _OPENER.open(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            sys.exit("blocked redirect from API host")
        detail = e.read().decode(errors="replace")[:300]
        if e.code == 401:
            sys.exit("HTTP 401: key rejected (wrong key or key owner lost repo access)")
        if e.code == 403:
            sys.exit("HTTP 403: plan lacks security scanning API access")
        if e.code == 429:
            time.sleep(20)
            return api(path, key)
        sys.exit("HTTP %s: %s" % (e.code, detail))
    except (http.client.IncompleteRead, ConnectionError, TimeoutError, urllib.error.URLError):
        # local proxies occasionally truncate the stream; retry the whole call
        time.sleep(5)
        return api(path, key)


def fetch_pages(key, query):
    """Yield all issues for a query string, following cursor pages."""
    issues, cursor = [], None
    while True:
        q = query + (("&cursor=" + urllib.parse.quote(str(cursor))) if cursor else "")
        body = api("/security-issues?" + q, key)
        data = body.get("data", [])
        issues.extend(data)
        cursor = body.get("next_cursor") or body.get("cursor")
        if not data or not cursor:
            return issues


def csv_list(value, allowed):
    out = [v.strip() for v in value.split(",") if v.strip()]
    bad = [v for v in out if allowed and v not in allowed]
    if bad:
        sys.exit("invalid values %s (allowed: %s)" % (bad, ",".join(allowed)))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repos", default="Stronghold-Protocol",
                    help="Sourcery repo names, comma separated")
    ap.add_argument("--repo-ids", default="",
                    help="Sourcery repository ids, comma separated — the rename-proof anchor. "
                         "When given, a name that no longer resolves is a warning (the id is "
                         "authoritative) and an id with zero ACTIVE findings is simply clean.")
    ap.add_argument("--fail-types", default="SECRET,DEPENDENCY",
                    help="issue types to fail on (default SECRET,DEPENDENCY)")
    ap.add_argument("--fail-severities", default="CRITICAL,HIGH",
                    help="severities to fail on (default CRITICAL,HIGH)")
    args = ap.parse_args()

    key = os.environ.get("SOURCERY_API_KEY")
    if not key:
        sys.exit("SOURCERY_API_KEY is not set")

    names = [n.strip() for n in args.repos.split(",") if n.strip()]
    want_ids = []
    for raw in args.repo_ids.split(","):
        raw = raw.strip()
        if not raw:
            continue
        if not raw.isdigit():
            sys.exit("invalid --repo-ids value: %r (digits only, comma separated)" % raw)
        want_ids.append(int(raw))
    fail_types = csv_list(args.fail_types, ISSUE_TYPES)
    fail_severities = csv_list(args.fail_severities, SEVERITIES)

    # Resolve names to ids from one unfiltered pass (the API exposes no repository registry —
    # the name→id map is derived from ACTIVE issues). Note the caveat this creates: a repo with
    # ZERO active findings has no name to look up. That is what --repo-ids is for: an id with no
    # findings is legitimately clean, while an unknown NAME stays fatal unless an id is provided.
    rmap = {}
    for i in fetch_pages(key, "limit=100&statuses=ACTIVE"):
        rmap.setdefault(i["repository_name"], i["repository_id"])

    unknown = [n for n in names if n not in rmap]
    if unknown and not want_ids:
        sys.exit("unknown repos in Sourcery account: %s" % ", ".join(unknown))
    for n in unknown:
        print("::warning::repo name %r not in the account's ACTIVE-issue map (renamed, or simply "
              "clean?) — proceeding on --repo-ids as the authoritative anchor" % n)

    targets = []  # (label, id)
    for name in names:
        if name in rmap and rmap[name] not in [tid for _l, tid in targets]:
            targets.append((name, rmap[name]))
    for rid in want_ids:
        if rid not in [tid for _l, tid in targets]:
            targets.append(("id:%d" % rid, rid))
    if not targets:
        sys.exit("no repos specified (--repos/--repo-ids both empty)")

    bad = []
    for _label, rid in targets:
        for i in fetch_pages(key, "limit=100&statuses=ACTIVE&repository_ids=%d" % rid):
            if i["issue_type"] in fail_types and i["severity"] in fail_severities:
                bad.append(i)

    if bad:
        print("GATE FAIL: %d finding(s) in %s" % (len(bad), ",".join(l for l, _ in targets)))
        for i in bad:
            print("%s %-8s %-10s %s:%s  %s" % (
                i["id"], i["severity"], i["issue_type"],
                i.get("file_path"), i.get("line_start"), (i.get("title") or "")[:90]))
        sys.exit(1)
    print("GATE PASS: %s clean for types=%s severities=%s" % (
        ",".join(l for l, _ in targets), ",".join(fail_types), ",".join(fail_severities)))


if __name__ == "__main__":
    main()
