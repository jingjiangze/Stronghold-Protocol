#!/usr/bin/env node
// tools/apk/sign.mjs — Ed25519 signing for the server list and the hot-update manifest.
//
//   node tools/apk/sign.mjs genkey [--out <dir>] [--pub-bin <path>]
//   node tools/apk/sign.mjs sign   <file.json> [--key <path>] [--out <path>]
//   node tools/apk/sign.mjs verify <file.json> [--pub <path>] [--pub-bin <path>]
//   node tools/apk/sign.mjs canonical <file.json>
//
// The private key never leaves this machine and never enters the repo (the plan pins only the
// public key into the APK). Keys are stored as hex: <dir>/ed25519.key (32-byte seed, 0600) and
// <dir>/ed25519.pub (32-byte public key). Signing happens locally, so no CI secret is involved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalBytes, canonicalize } from './canonical.mjs';
import { generateSeed, privateKeyFromSeed, publicKeyFromRaw, rawPublicOf, sign as edSign, verify as edVerify } from './ed25519.mjs';

const DEFAULT_DIR = process.env.SP_SIGN_DIR || path.join(os.homedir(), '.sp-sign');
const KEY_FILE = 'ed25519.key';
const PUB_FILE = 'ed25519.pub';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function cmd() {
  return process.argv[2];
}

function loadSeed(dir) {
  const file = path.join(dir, KEY_FILE);
  if (!fs.existsSync(file)) throw new Error(`no private key at ${file} — run: node tools/apk/sign.mjs genkey`);
  const seed = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (seed.length !== 32) throw new Error(`malformed private key (${seed.length} bytes, expected 32)`);
  return seed;
}

function loadPub(dir, explicit) {
  const file = explicit || path.join(dir, PUB_FILE);
  if (!fs.existsSync(file)) throw new Error(`no public key at ${file}`);
  const raw = file.endsWith('.bin')
    ? fs.readFileSync(file)
    : Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (raw.length !== 32) throw new Error(`malformed public key (${raw.length} bytes, expected 32)`);
  return raw;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeKeyFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  try {
    fs.chmodSync(file, 0o600); // best effort: Windows ignores POSIX modes
  } catch { /* ignore */ }
}

function genkey() {
  const dir = arg('--out') || DEFAULT_DIR;
  const seed = generateSeed();
  const pub = rawPublicOf(privateKeyFromSeed(seed));
  writeKeyFile(path.join(dir, KEY_FILE), seed.toString('hex') + '\n');
  writeKeyFile(path.join(dir, PUB_FILE), pub.toString('hex') + '\n');
  const pubBin = arg('--pub-bin');
  if (pubBin) {
    fs.mkdirSync(path.dirname(pubBin), { recursive: true });
    fs.writeFileSync(pubBin, pub);
  }
  console.log(`private key: ${path.join(dir, KEY_FILE)}`);
  console.log(`public key : ${path.join(dir, PUB_FILE)}${pubBin ? ` (+ ${pubBin})` : ''}`);
  console.log(`pubkey hex : ${pub.toString('hex')}`);
  console.log(`pubkey b64 : ${pub.toString('base64')}`);
}

function sign() {
  const file = process.argv[3];
  if (!file) throw new Error('usage: sign <file.json>');
  const keyDir = arg('--key') ? path.dirname(arg('--key')) : DEFAULT_DIR;
  const seed = loadSeed(keyDir);
  const doc = readJson(file);
  const bytes = canonicalBytes(doc);
  const sig = edSign(bytes, seed);
  doc.sig = sig.toString('base64');
  const out = arg('--out') || file;
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(`signed ${path.basename(file)} → ${out}`);
  console.log(`  payload ${bytes.length} B, sig ${sig.length} B, pubkey ${rawPublicOf(privateKeyFromSeed(seed)).toString('hex').slice(0, 16)}…`);
}

function verify() {
  const file = process.argv[3];
  if (!file) throw new Error('usage: verify <file.json>');
  const pub = loadPub(arg('--key') ? path.dirname(arg('--key')) : DEFAULT_DIR, arg('--pub') || arg('--pub-bin'));
  const doc = readJson(file);
  if (typeof doc.sig !== 'string') throw new Error('document has no `sig` field');
  const ok = edVerify(canonicalBytes(doc), Buffer.from(doc.sig, 'base64'), pub);
  console.log(`${ok ? 'VALID' : 'INVALID'} — ${file}`);
  if (!ok) process.exit(1);
}

function canonical() {
  const file = process.argv[3];
  if (!file) throw new Error('usage: canonical <file.json>');
  const doc = readJson(file);
  const { sig, ...rest } = doc;
  process.stdout.write(canonicalize(rest) + '\n');
}

function main() {
  switch (cmd()) {
    case 'genkey': return genkey();
    case 'sign': return sign();
    case 'verify': return verify();
    case 'canonical': return canonical();
    default:
      console.error('usage: sign.mjs genkey|sign|verify|canonical <file.json> [--out|--key|--pub|--pub-bin]');
      process.exit(2);
  }
}

main();
