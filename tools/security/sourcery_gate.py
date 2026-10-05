#!/usr/bin/env python3
"""Sourcery security gate for CI.

Fails (exit 1) when ACTIVE findings in the given Sourcery repositories match
the failing severities/types. Read-only: it never mutates triage state.

Auth: SOURCERY_API_KEY environment variable (set as a repo secret in CI,
never hardcoded). Keys live at https://app.sourcery.ai/dashboard/api-keys

Usage:
  python sourcery_gate.py --repos "Stronghold-Protocol" \
      --fail-types SECRET,DEPENDENCY --fail-severities CRITICAL,HIGH
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
    ap.add_argument("--fail-types", default="SECRET,DEPENDENCY",
                    help="issue types to fail on (default SECRET,DEPENDENCY)")
    ap.add_argument("--fail-severities", default="CRITICAL,HIGH",
                    help="severities to fail on (default CRITICAL,HIGH)")
    args = ap.parse_args()

    key = os.environ.get("SOURCERY_API_KEY")
    if not key:
        sys.exit("SOURCERY_API_KEY is not set")

    names = [n.strip() for n in args.repos.split(",") if n.strip()]
    fail_types = csv_list(args.fail_types, ISSUE_TYPES)
    fail_severities = csv_list(args.fail_severities, SEVERITIES)

    # map names to ids from one unfiltered pass, then query each repo
    rmap = {}
    for i in fetch_pages(key, "limit=100&statuses=ACTIVE"):
        rmap.setdefault(i["repository_name"], i["repository_id"])
    unknown = [n for n in names if n not in rmap]
    if unknown:
        sys.exit("unknown repos in Sourcery account: %s" % ", ".join(unknown))

    bad = []
    for name in names:
        for i in fetch_pages(key, "limit=100&statuses=ACTIVE&repository_ids=%d" % rmap[name]):
            if i["issue_type"] in fail_types and i["severity"] in fail_severities:
                bad.append(i)

    if bad:
        print("GATE FAIL: %d finding(s) in %s" % (len(bad), ",".join(names)))
        for i in bad:
            print("%s %-8s %-10s %s:%s  %s" % (
                i["id"], i["severity"], i["issue_type"],
                i.get("file_path"), i.get("line_start"), (i.get("title") or "")[:90]))
        sys.exit(1)
    print("GATE PASS: %s clean for types=%s severities=%s" % (
        ",".join(names), ",".join(fail_types), ",".join(fail_severities)))


if __name__ == "__main__":
    main()
