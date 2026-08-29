#!/usr/bin/env python3
import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()
OUTPUT = ROOT / "ai-logs"
BUILD = ROOT / ".runtime" / "ai-logs-build"
MAIN_CUTOFF_SHA256 = "029bebb758e51249999ae611fb767dc45e1e6c3de2c47eb0abb997cf720ea79d"
MAIN_START_RECORD = 12
MAX_TOOL_BYTES = 8_000
PUBLIC_REPOSITORY = "https://github.com/shishiv/autoseguro"
VERIFY_FINGERPRINT = "d10cef5078bd77a7c41168d49c08d7009ece21d40f1aed26f0e6690bdf6f941f"
EXTERNAL_PUBLIC_COMMITS = {
    "52a006ca8ea571c3b9618be6886cb2ee20b6f6b8",
    "b617ef83b736b90b94bf145b554b5cb3128f518b",
}


MAIN = {
    "label": "main-orchestration",
    "path": None,
    "timestamp": "2026-08-28T14-58-55-819Z",
    "output": "ai-logs/sessions/2026-08-28-main-orchestration.jsonl",
    "shipped": True,
}

WORKERS = [
    {
        "label": "core-implementation",
        "path": None,
        "timestamp": "2026-08-28T15-12-13-638Z",
        "output": "ai-logs/sessions/2026-08-28-core-implementation.jsonl",
        "marker": "Build the AutoSeguro WhatsApp insurance-sales agent",
        "expected_sha256": "e2b6e353db5b1e699fceec2c0de60b1678a98312e04c309ffe6b81fcc661cfe4",
        "expected_bytes": 2726086,
        "shipped": True,
    },
    {
        "label": "meta-pilot",
        "path": None,
        "timestamp": "2026-08-28T22-38-51-545Z",
        "output": "ai-logs/sessions/2026-08-28-meta-pilot.jsonl",
        "marker": "Put the revised AutoSeguro asynchronous flow on the isolated Meta Test",
        "expected_sha256": "db8c5a121008bbf04aa5847aba6f102fda139ce98e6d0d546425bb03a4f758d2",
        "expected_bytes": 2386880,
        "shipped": True,
    },
    {
        "label": "whatsapp-ux",
        "path": None,
        "timestamp": "2026-08-29T08-22-14-040Z",
        "output": "ai-logs/sessions/2026-08-29-whatsapp-ux.jsonl",
        "marker": "Build a separate UX-focused PR",
        "expected_sha256": "d317725a7814939f0dc02b5cbe8412e31226caa4d28c81d01397cde0a34b3077",
        "expected_bytes": 2818805,
        "shipped": True,
    },
    {
        "label": "verification-skill-builder",
        "path": None,
        "timestamp": "2026-08-29T12-39-57-111Z",
        "output": "ai-logs/sessions/2026-08-29-verification-skill-builder.jsonl",
        "marker": "Create and prove a project-local verification skill",
        "expected_sha256": "fa19ef594be97ca43ff70df2bcd15eb9320f33b5c11950b59676d7e04a89c4ce",
        "expected_bytes": 2012770,
        "shipped": True,
    },
    {
        "label": "independent-audit",
        "path": None,
        "timestamp": "2026-08-29T14-15-50-015Z",
        "output": "ai-logs/sessions/2026-08-29-independent-audit.jsonl",
        "marker": "Independently audit the merged AutoSeguro verification capability",
        "expected_sha256": "1e3d0fa8cc6de586cf7bd66d3ee9da865f77bd74517bf32675a362a244f3ff5a",
        "expected_bytes": 504027,
        "shipped": True,
    },
]

CURSOR = {
    "label": "cursor-mvp-superseded",
    "path": HOME / "Projects/namastex-fde-challenge/ai-logs/2026-08-27-cursor-mvp-build.md",
    "output": "ai-logs/sessions/2026-08-27-cursor-mvp-superseded.jsonl",
    "expected_sha256": "6a782f8c429d08d2f3c641df6810b21769747d8a1ab46524ca58f59860ea142d",
    "expected_bytes": 1093,
    "shipped": False,
}

RESULT_SOURCES = {
    "real-conversation": [ROOT / "examples/conversation-real.md", ROOT / "examples/conversation-real.audit.jsonl"],
    "reliability-100": [ROOT / "examples/evaluation/reliability-100.json", ROOT / "examples/evaluation/reliability-100.md"],
    "meta-live-proof": [ROOT / "docs/meta-provisioning-evidence.json"],
    "verification-skill": [
        ROOT / ".cursor/skills/verify-autoseguro/SKILL.md",
        ROOT / ".cursor/skills/verify-autoseguro/verify.mjs",
        ROOT / ".cursor/skills/verify-autoseguro/scenarios.json",
        ROOT / ".cursor/skills/verify-autoseguro/features/README.md",
        ROOT / ".cursor/skills/verify-autoseguro/features/ending-csat.md",
        ROOT / ".cursor/skills/verify-autoseguro/features/failure-handoff.md",
        ROOT / ".cursor/skills/verify-autoseguro/features/greeting-plan-selection.md",
        ROOT / ".cursor/skills/verify-autoseguro/features/pending-async-delivery.md",
        ROOT / ".cursor/skills/verify-autoseguro/features/progressive-quote-success.md",
    ],
    "independent-audit-report": [HOME / "Projects/shivmate/data/autoseguro-e2e-independent-audit/report.md"],
    "fresh-npm-check": [BUILD / "fresh-npm-check.json", BUILD / "fresh-npm-check.log"],
    "fresh-verification": [
        ROOT / ".artifacts/verify-autoseguro/ai-logs-fresh-final/summary.json",
        ROOT / ".artifacts/verify-autoseguro/ai-logs-fresh-final/build.log",
        ROOT / ".artifacts/verify-autoseguro/ai-logs-fresh-final/commands.log",
    ],
}

SENSITIVE_NAME = re.compile(r"(?:^|_)(?:api_?key|key|token|secret|password|credential|cookie|authorization|auth|pin|email|phone|recipient|waba_?id|phone_?number_?id|app_?id|private_?url|base_?url|hostname)(?:$|_)", re.I)
OPERATIONAL = re.compile(r"FIRSTMATE WATCHER|TURN WOULD END BLIND|fm-wake|fm_watch|turn-ended|\.inbox/|\.status(?:\b|')|tasks-axi|quota-axi|harness busy|watcher:", re.I)
SUBSTANTIVE_COMMAND = re.compile(r"npm |node |git |gh-axi|curl |docker |python |pytest|uv ", re.I)
PRIVATE_SOURCE = re.compile(r"DOSSIE-KHAL|/Downloads/DOSSIE|candidate dossier", re.I)
INTERNAL_SKILL = re.compile(r"(?:\.agents/skills|\.pi/agent/(?:skills|npm/[^\s]+/skills))/(?!verify-autoseguro)", re.I)
INTERNAL_TOOLING = re.compile(r"(?:/home/[^/]+/Projects/shivmate/(?:bin|\.agents|state|config)/|/home/[^/]+/Projects/shivmate/data/[^/]+/brief\.md|\bbin/fm-[\w-]+\.sh\b)", re.I)
LOCAL_INVENTORY = re.compile(r"\bls\s+['\"]?/home/[^/]+/Projects/?(?:['\";\s]|$)", re.I)
SESSION_INVENTORY = re.compile(r"\.pi/agent/sessions/--home-", re.I)
SECURITY_SCAN = re.compile(r"\brg\b[^\n]*(?:PRIVATE KEY|api[_-]?key|access[_-]?token|Bearer)", re.I)
UNRELATED = re.compile(r"\b(?:NATS|BullMQ|JetStream|automagik-dev/omni|Omni)\b", re.I)


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def source_bytes(path, cutoff=None):
    with path.open("rb") as handle:
        value = handle.read() if cutoff is None else handle.read(cutoff)
    if cutoff is not None and len(value) != cutoff:
        raise RuntimeError(f"declared cutoff exceeds source size: {path.name}")
    return value
def bind_source_map(path):
    mapping = json.loads(path.read_text(encoding="utf-8"))
    items = [MAIN, *WORKERS]
    labels = {item["label"] for item in items}
    if set(mapping) != labels:
        raise RuntimeError("source map must contain exactly the six declared session labels")
    session_root = (HOME / ".pi/agent/sessions").resolve()
    for item in items:
        source = Path(os.path.expandvars(mapping[item["label"]])).expanduser().resolve(strict=True)
        if not source.is_relative_to(session_root) or source.suffix != ".jsonl" or not source.name.startswith(f"{item['timestamp']}_"):
            raise RuntimeError(f"source map path rejected for {item['label']}")
        item["path"] = source




def public_commits():
    result = subprocess.run(
        ["git", "rev-list", "--all", "--reflog"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    return set(result.stdout.split()) | EXTERNAL_PUBLIC_COMMITS


def secret_values():
    values = set()
    dotenv = HOME / ".pi/agent/.env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            if SENSITIVE_NAME.search(name.strip()) and len(value.strip().strip("'\"")) >= 6:
                values.add(value.strip().strip("'\""))
    auth = HOME / ".pi/agent/auth.json"
    if auth.exists():
        def visit(value, name=""):
            if isinstance(value, dict):
                for key, child in value.items():
                    visit(child, key)
            elif isinstance(value, list):
                for child in value:
                    visit(child, name)
            elif isinstance(value, str) and SENSITIVE_NAME.search(name) and len(value) >= 6:
                values.add(value)
        visit(json.loads(auth.read_text(encoding="utf-8")))
    for name, value in os.environ.items():
        if SENSITIVE_NAME.search(name) and len(value) >= 6:
            values.add(value)
    return sorted(values, key=len, reverse=True)


class Scrubber:
    def __init__(self, denyset, known_commits):
        self.denyset = denyset
        self.known_commits = known_commits
        self.counts = collections.Counter()
        self.path_aliases = {
            str(ROOT): "$PROJECT",
            str(HOME / ".treehouse/autoseguro-8454ce/1/autoseguro"): "$WORKTREE",
            str(HOME / "Projects/shivmate/projects/autoseguro"): "$PROJECT",
            str(MAIN["path"]): "<source:main-orchestration>",
            str(CURSOR["path"]): "<source:cursor-mvp-superseded>",
        }
        self.path_aliases.update({str(item["path"]): f"<source:{item['label']}>" for item in WORKERS})

    def sub(self, pattern, replacement, text, category, flags=0):
        text, count = re.subn(pattern, replacement, text, flags=flags)
        self.counts[category] += count
        return text

    def text(self, value):
        text = str(value)
        for secret in self.denyset:
            count = text.count(secret)
            if count:
                text = text.replace(secret, "<secret-redacted>")
                self.counts["exact_secret"] += count
        for path, alias in sorted(self.path_aliases.items(), key=lambda item: len(item[0]), reverse=True):
            count = text.count(path)
            if count:
                text = text.replace(path, alias)
                self.counts["absolute_path"] += count
        text = self.sub(r"(?:\$HOME/Downloads/)?DOSSIE-KHAL-FDE-[A-Za-z-]+\.md", "<private-candidate-dossier>", text, "private_source_reference", re.I)
        text = self.sub(r"-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----", "<private-key-redacted>", text, "private_key", re.I)
        text = self.sub(r"(?im)\b(authorization[\"']?\s*[:=]\s*)(?!<)[^\r\n]+", r"\1<authorization-redacted>", text, "authorization")
        text = self.sub(r"(?i)\bbearer\s+(?!<)[A-Za-z0-9._~+/=-]{8,}", "Bearer <bearer-redacted>", text, "bearer_token")
        text = self.sub(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b", "<jwt-redacted>", text, "jwt")
        text = self.sub(r"(?im)\b((?:set-)?cookie\s*[:=]\s*)(?!<)[^\r\n]+", r"\1<cookie-redacted>", text, "cookie")
        text = self.sub(r"(?i)\b((?:api[_-]?key|access[_-]?token|app[_-]?secret|verify[_-]?token|webhook[_-]?secret|password|pin)[\"']?\s*[:=]\s*)[\"']?(?!<[^>]*redacted>|\$\{)[^\s,;'\"}]+[\"']?", r"\1<credential-redacted>", text, "credential_assignment")
        text = self.sub(r"https?://login\.tailscale\.com/\S+", "<tailscale-login-redacted>", text, "tailscale_login", re.I)
        text = self.sub(r"https?://[^\s'\"]*(?:oauth|authorize)[^\s'\"]*", "<oauth-url-redacted>", text, "oauth_url", re.I)
        text = self.sub(r"https?://(?:[A-Za-z0-9-]+\.)*triangulotec\.com\.br(?::\d+)?[^\s'\"`)]*", "https://<private-host>", text, "private_host", re.I)
        text = self.sub(r"(?<![\w.-])(?:[A-Za-z0-9-]+\.)*triangulotec\.com\.br\b", "<private-host>", text, "private_host", re.I)
        text = self._redact_unknown_hashes(text)
        text = self.sub(r"\*{4,}\d{3,6}", "<meta-id-redacted>", text, "meta_identifier")
        text = self.sub(r"(?<![0-9a-f])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-f])", "<uuid-redacted>", text, "terminal_session_id", re.I)
        text = self.sub(r"\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b", "<private-ip-redacted>", text, "private_host")
        text = self.sub(r"\b\d{7,16}@(s\.whatsapp\.net|c\.us|g\.us)\b", "<whatsapp-jid-redacted>", text, "whatsapp_jid", re.I)
        text = self.sub(r"(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.-])", "<email-redacted>", text, "email")
        text = self.sub(r"(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)", "<cpf-redacted>", text, "cpf")
        text = self.sub(r"(?<!\w)\+\d{8,15}\b", "<phone-redacted>", text, "phone")
        text = self.sub(r"(?<![\w-])(?:\(?\d{2}\)?[ .-]?)?9?\d{4}[ .-]\d{4}(?![\w-])", "<phone-redacted>", text, "phone")
        text = self.sub(r"(?<![\w-])\d{10,17}(?![\w-])", "<numeric-id-redacted>", text, "meta_identifier")
        text = self.sub(r"(?<!\d)(\d{2})\d{3}-?\d{3}(?!\d)", r"\1***-***", text, "cep")
        text = self.sub(r"\b(?:term_[A-Za-z0-9]+|bt-\d+|default:w[A-Za-z0-9]+:p\d+|w[A-Za-z0-9]+:[pt]\d+)\b", "<terminal-id-redacted>", text, "terminal_session_id")
        text = self.sub(r"#[A-F0-9]{16}\b", "#<file-tag-redacted>", text, "terminal_session_id")
        text = self.sub(r"(?<![\w])/(?:tmp|proc)/[^\s'\"`]+", "<temporary-path>", text, "absolute_path")
        text = self.sub(r"/(?:home|Users)/[^/\s]+", "$HOME", text, "absolute_path")
        text = self.sub(r"(?<![\w/])~/(?=\S)", "$HOME/", text, "absolute_path")
        text = self.sub(r"(?im)^((?:Author|Commit):\s*)[^<\n]+(?=\s+<)", r"\1<person-redacted>", text, "personal_name")
        local_user = re.escape(os.environ.get("USER", ""))
        if local_user:
            text = self.sub(rf"(?<![\w/]){local_user}(?![\w])", "<local-user-redacted>", text, "local_username", re.I)
        text = self._redact_speakers(text)
        text = self._redact_blobs(text)
        return text

    def _redact_speakers(self, text):
        pattern = re.compile(r"(\[\d{2}:\d{2},[^\]]+\]\s*)([^:\n]{2,80})(:)")
        def replace(match):
            speaker = match.group(2).strip()
            if speaker == "AutoSeguro" or "redacted" in speaker:
                return match.group(0)
            self.counts["personal_name"] += 1
            return f"{match.group(1)}<person-redacted>{match.group(3)}"
        return pattern.sub(replace, text)

    def _redact_unknown_hashes(self, text):
        pattern = re.compile(r"\b(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})\b", re.I)
        def replace(match):
            token = match.group(0)
            if token in self.known_commits or token == VERIFY_FINGERPRINT:
                return token
            self.counts["operational_identifier"] += 1
            return "<hash-redacted>"
        return pattern.sub(replace, text)

    def _redact_blobs(self, text):
        pattern = re.compile(r"(?<![\w])(?=[A-Za-z0-9_+=-]{28,}(?![\w]))[A-Za-z0-9_+=-]+")
        def replace(match):
            token = match.group(0)
            if token in self.known_commits or token == VERIFY_FINGERPRINT or re.fullmatch(r"[a-z]+(?:-[a-z0-9]+)+", token):
                return token
            frequencies = collections.Counter(token)
            entropy = -sum((count / len(token)) * math.log2(count / len(token)) for count in frequencies.values())
            classes = sum(bool(re.search(pattern, token)) for pattern in (r"[a-z]", r"[A-Z]", r"\d", r"[_+/=]"))
            if entropy < 4.2 or classes < 2:
                return token
            self.counts["credential_blob"] += 1
            return "<credential-blob-redacted>"
        return pattern.sub(replace, text)

    def obj(self, value, key=""):
        lowered = key.lower()
        if isinstance(value, dict):
            return {name: self.obj(child, name) for name, child in value.items()}
        if isinstance(value, list):
            return [self.obj(child, key) for child in value]
        if value is None or isinstance(value, (bool, int, float)):
            return value
        if re.search(r"authorization|cookie|token|secret|password|api.?key|\bpin\b", lowered):
            self.counts["structured_credential"] += 1
            return "<credential-redacted>"
        if re.search(r"waba|phone_number_id|app_id|recipient|whatsapp_jid|terminal_id|session_id|workspace_id|pane_id|tab_id", lowered):
            self.counts["structured_identifier"] += 1
            return "<identifier-redacted>"
        if lowered in {"to", "from", "phone"} and re.fullmatch(r"\+?\d{7,17}", str(value)):
            self.counts["structured_identifier"] += 1
            return "<identifier-redacted>"
        return self.text(value)


def omission(label, timestamp, record, omission_type, raw, basis="raw-jsonl-record", **extra):
    value = {
        "timestamp": timestamp,
        "source": label,
        "source_record": record,
        "kind": "omission",
        "omission_type": omission_type,
        "source_fragment_sha256": sha256_bytes(raw),
        "source_bytes": len(raw),
        "hash_basis": basis,
    }
    value.update(extra)
    return value


def text_parts(message):
    content = message.get("content", [])
    if not isinstance(content, list):
        return []
    return [part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"]


def record_class(text, tool_name=None):
    rendered = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    if tool_name == "read" and re.search(r"\.inbox/[^/]+\.msg\b", rendered):
        return None
    if tool_name == "read" and re.search(r"(?:^|[/\"'])AGENTS\.md|(?:^|[/\"'])CLAUDE\.md", rendered, re.I):
        return "system_developer_instruction"
    if tool_name is not None and PRIVATE_SOURCE.search(rendered):
        return "private_candidate_dossier"
    if rendered.lstrip().startswith("<skill ") or (tool_name is not None and INTERNAL_SKILL.search(rendered)):
        return "system_developer_instruction"
    if tool_name is not None and INTERNAL_TOOLING.search(rendered) and not SUBSTANTIVE_COMMAND.search(rendered):
        return "internal_orchestration_tooling"
    if tool_name is not None and SESSION_INVENTORY.search(rendered):
        return "source_inventory"
    if tool_name is not None and LOCAL_INVENTORY.search(rendered):
        return "unrelated_local_inventory"
    if tool_name is not None and SECURITY_SCAN.search(rendered):
        return "security_scan_details"
    if UNRELATED.search(rendered):
        return "unrelated_project_discussion"
    if OPERATIONAL.search(rendered) and not SUBSTANTIVE_COMMAND.search(rendered):
        return "operational_watcher_traffic"
    if tool_name in {"bg_list"}:
        return "operational_watcher_traffic"
    return None


def launch_task(text):
    if "FIRSTMATE_OP: v1 launch-brief" not in text or "# Task" not in text:
        return None
    start = text.index("# Task")
    boundaries = [
        text.find(header, start)
        for header in ("\n# Plays", "\n# Herdr lifecycle declaration", "\n# Setup", "\n# Rules", "\n# Firstmate instruction inbox", "\n# Project memory", "\n# Definition of done")
        if text.find(header, start) >= 0
    ]
    end = min(boundaries, default=len(text))
    return text[start:end].strip(), text[:start].encode(), text[end:].encode()


def json_line(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"


def session_first_prompt(path):
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            message = row.get("message")
            if isinstance(message, dict) and message.get("role") == "user":
                return "\n".join(text_parts(message))
    return ""


def verify_worker_mapping():
    prompts = {item["label"]: session_first_prompt(item["path"]) for item in WORKERS}
    for item in WORKERS:
        matches = [label for label, prompt in prompts.items() if item["marker"] in prompt]
        if matches != [item["label"]]:
            raise RuntimeError(f"ambiguous worker mapping for {item['label']}: {matches}")
    if len({item["path"] for item in WORKERS}) != 5 or len({item["label"] for item in WORKERS}) != 5:
        raise RuntimeError("worker allowlist must contain five unique sessions and roles")
    hashes = [sha256_bytes(source_bytes(item["path"])) for item in WORKERS]
    if len(set(hashes)) != 5:
        raise RuntimeError("duplicate worker session content in allowlist")


def export_session(item, denyset, commits, cutoff=None, start_record=1):
    path = item["path"]
    raw_source = source_bytes(path, cutoff)
    source_sha = sha256_bytes(raw_source)
    expected_sha = item.get("expected_sha256")
    expected_bytes = item.get("expected_bytes")
    if expected_sha and source_sha != expected_sha:
        raise RuntimeError(f"source hash changed for {item['label']}")
    if expected_bytes and len(raw_source) != expected_bytes:
        raise RuntimeError(f"source size changed for {item['label']}")
    scrubber = Scrubber(denyset, commits)
    rows = []
    call_map = {}
    next_call = 0
    lines = raw_source.splitlines(keepends=True)
    if start_record > 1:
        prefix = b"".join(lines[:start_record - 1])
        first = json.loads(lines[0]) if lines else {}
        rows.append(omission(item["label"], first.get("timestamp"), f"1-{start_record - 1}", "outside_challenge_interval", prefix))
    for index, raw_line in enumerate(lines[start_record - 1:], start_record):
        row = json.loads(raw_line)
        timestamp = row.get("timestamp") or row.get("message", {}).get("timestamp")
        if row.get("type") != "message":
            rows.append(omission(item["label"], timestamp, index, "transport_metadata", raw_line))
            continue
        message = row.get("message", {})
        role = message.get("role")
        if role == "bashExecution":
            rows.append(omission(item["label"], timestamp, index, "duplicate_transport_record", raw_line))
            continue
        if role in {"system", "developer"}:
            rows.append(omission(item["label"], timestamp, index, "system_developer_instruction", raw_line))
            continue
        if role == "user":
            text = "\n".join(text_parts(message))
            split = launch_task(text)
            if split:
                task, prefix, suffix = split
                if prefix:
                    rows.append(omission(item["label"], timestamp, index, "orchestration_scaffold", prefix, "utf8-content", fragment="prefix"))
                rows.append({
                    "timestamp": timestamp,
                    "source": item["label"],
                    "source_record": index,
                    "kind": "user_prompt",
                    "text": scrubber.text(task),
                })
                if suffix:
                    rows.append(omission(item["label"], timestamp, index, "orchestration_scaffold", suffix, "utf8-content", fragment="suffix"))
            else:
                category = record_class(text)
                if category:
                    rows.append(omission(item["label"], timestamp, index, category, raw_line))
                    continue
                rows.append({
                    "timestamp": timestamp,
                    "source": item["label"],
                    "source_record": index,
                    "kind": "user_prompt",
                    "text": scrubber.text(text),
                })
            continue
        if role == "assistant":
            content = message.get("content", [])
            if not isinstance(content, list):
                rows.append(omission(item["label"], timestamp, index, "unrecognized_content", raw_line))
                continue
            for part_index, part in enumerate(content):
                raw_part = json.dumps(part, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
                part_type = part.get("type") if isinstance(part, dict) else None
                if part_type in {"thinking", "reasoning"}:
                    rows.append(omission(item["label"], timestamp, index, "hidden_reasoning", raw_part, "canonical-json-part", part_index=part_index))
                elif part_type == "text":
                    text = part.get("text", "")
                    category = record_class(text)
                    if category:
                        rows.append(omission(item["label"], timestamp, index, category, raw_part, "canonical-json-part", part_index=part_index))
                    else:
                        rows.append({
                            "timestamp": timestamp,
                            "source": item["label"],
                            "source_record": index,
                            "part_index": part_index,
                            "kind": "assistant_visible",
                            "text": scrubber.text(text),
                        })
                elif part_type == "toolCall":
                    next_call += 1
                    logical_call = f"call-{next_call:04d}"
                    raw_call = part.get("id")
                    tool_name = part.get("name", "unknown")
                    arguments = part.get("arguments", {})
                    category = record_class(arguments, tool_name)
                    call_map[raw_call] = (logical_call, category, tool_name)
                    if category:
                        rows.append(omission(item["label"], timestamp, index, category, raw_part, "canonical-json-part", part_index=part_index, tool_name=tool_name, call_id=logical_call))
                    elif len(raw_part) > MAX_TOOL_BYTES:
                        rows.append({
                            "timestamp": timestamp,
                            "source": item["label"],
                            "source_record": index,
                            "part_index": part_index,
                            "kind": "tool_call",
                            "call_id": logical_call,
                            "tool_name": tool_name,
                            "arguments": {
                                "omission_type": "large_tool_arguments",
                                "source_fragment_sha256": sha256_bytes(raw_part),
                                "source_bytes": len(raw_part),
                                "hash_basis": "canonical-json-part",
                            },
                        })
                    else:
                        rows.append({
                            "timestamp": timestamp,
                            "source": item["label"],
                            "source_record": index,
                            "part_index": part_index,
                            "kind": "tool_call",
                            "call_id": logical_call,
                            "tool_name": tool_name,
                            "arguments": scrubber.obj(arguments),
                        })
                else:
                    rows.append(omission(item["label"], timestamp, index, "binary_or_unrecognized_content", raw_part, "canonical-json-part", part_index=part_index))
            continue
        if role == "toolResult":
            raw_call = message.get("toolCallId")
            logical_call, category, tool_name = call_map.get(raw_call, ("call-unmatched", None, message.get("toolName", "unknown")))
            if category:
                rows.append(omission(item["label"], timestamp, index, category, raw_line, tool_name=tool_name, call_id=logical_call))
                continue
            content = message.get("content", [])
            if not isinstance(content, list):
                rows.append(omission(item["label"], timestamp, index, "unrecognized_tool_result", raw_line, tool_name=tool_name, call_id=logical_call))
                continue
            for part_index, part in enumerate(content):
                if not isinstance(part, dict) or part.get("type") != "text":
                    raw_part = json.dumps(part, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
                    rows.append(omission(item["label"], timestamp, index, "binary_blob", raw_part, "canonical-json-part", part_index=part_index, tool_name=tool_name, call_id=logical_call))
                    continue
                raw_text = part.get("text", "").encode()
                content_category = record_class(part.get("text", ""), tool_name)
                if content_category:
                    rows.append(omission(item["label"], timestamp, index, content_category, raw_text, "utf8-content", part_index=part_index, tool_name=tool_name, call_id=logical_call))
                elif len(raw_text) > MAX_TOOL_BYTES:
                    rows.append(omission(item["label"], timestamp, index, "large_tool_output", raw_text, "utf8-content", part_index=part_index, tool_name=tool_name, call_id=logical_call))
                else:
                    rows.append({
                        "timestamp": timestamp,
                        "source": item["label"],
                        "source_record": index,
                        "part_index": part_index,
                        "kind": "tool_result",
                        "call_id": logical_call,
                        "tool_name": tool_name,
                        "is_error": bool(message.get("isError")),
                        "text": scrubber.text(part.get("text", "")),
                    })
            continue
        rows.append(omission(item["label"], timestamp, index, "unrecognized_role", raw_line, role=str(role)))
    timestamps = [row["timestamp"] for row in rows if row.get("timestamp")]
    if timestamps != sorted(timestamps):
        raise RuntimeError(f"non-chronological output for {item['label']}")
    output_path = ROOT / item["output"]
    output_path.write_text("".join(json_line(row) for row in rows), encoding="utf-8")
    return {
        "logical_label": item["label"],
        "source_kind": "pi-session-jsonl",
        "source_sha256": source_sha,
        "source_bytes": len(raw_source),
        "source_byte_cutoff": cutoff,
        "source_records": len(lines),
        "sanitized_output_path": item["output"],
        "retained_records": sum(row["kind"] != "omission" for row in rows),
        "omission_records": sum(row["kind"] == "omission" for row in rows),
        "redactions": {name: count for name, count in sorted(scrubber.counts.items()) if count},
        "shipped": item["shipped"],
        "superseded": not item["shipped"],
    }


def export_cursor(denyset, commits):
    raw = source_bytes(CURSOR["path"])
    if len(raw) != CURSOR["expected_bytes"] or sha256_bytes(raw) != CURSOR["expected_sha256"]:
        raise RuntimeError("superseded Cursor source changed")
    scrubber = Scrubber(denyset, commits)
    row = {
        "timestamp": "2026-08-27",
        "source": CURSOR["label"],
        "source_record": 1,
        "kind": "source_summary",
        "disposition": "superseded_not_shipped",
        "text": scrubber.text(raw.decode("utf-8")),
        "limitation": "Only the historical summary was available. No raw Cursor transcript was published or inferred.",
    }
    (ROOT / CURSOR["output"]).write_text(json_line(row), encoding="utf-8")
    return {
        "logical_label": CURSOR["label"],
        "source_kind": "cursor-session-summary",
        "source_sha256": sha256_bytes(raw),
        "source_bytes": len(raw),
        "source_byte_cutoff": None,
        "source_records": 1,
        "sanitized_output_path": CURSOR["output"],
        "retained_records": 1,
        "omission_records": 0,
        "redactions": {name: count for name, count in sorted(scrubber.counts.items()) if count},
        "shipped": False,
        "superseded": True,
    }


def source_entry(label, path, output, scrubber=None, retained=1, omissions=0):
    raw = source_bytes(path)
    try:
        display = str(path.relative_to(ROOT))
    except ValueError:
        display = f"logical-source:{label}"
    return {
        "logical_label": label,
        "source_kind": "repository-file" if path.is_relative_to(ROOT) else "private-evidence-file",
        "source_name": display,
        "source_sha256": sha256_bytes(raw),
        "source_bytes": len(raw),
        "source_byte_cutoff": None,
        "source_records": 1,
        "sanitized_output_path": output,
        "retained_records": retained,
        "omission_records": omissions,
        "redactions": {name: count for name, count in sorted((scrubber.counts if scrubber else {}).items()) if count},
        "shipped": True,
        "superseded": False,
    }


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def historical_checks():
    return {
        "schema_version": 1,
        "title": "Historical local checks for PRs 1-4",
        "policy": "Only commands and outcomes present in the sanitized sessions are listed. Iterative failures remain visible because they drove corrections.",
        "pull_requests": [
            {
                "pull_request": f"{PUBLIC_REPOSITORY}/pull/1",
                "merge_commit": "43a552898962edc108573bed331072c304f0f3ad",
                "final_source_commit": "b7ef112bd169ff9d94a265d913e4526f62bb1c65",
                "checks": [
                    {"timestamp": "2026-08-28T15:29:00.293Z", "command": "npm run check", "exit_code": 0, "tests": 14, "passed": 14, "failed": 0, "source_record": 151},
                    {"timestamp": "2026-08-28T16:53:37.448Z", "command": "npm run check", "exit_code": 0, "tests": 22, "passed": 22, "failed": 0, "source_record": 633},
                ],
                "source": "../sessions/2026-08-28-core-implementation.jsonl",
            },
            {
                "pull_request": f"{PUBLIC_REPOSITORY}/pull/2",
                "merge_commit": "47bb14c8808a44d140ff4c866897781ac646e5da",
                "final_source_commit": "c3ea8a8b66e95ce2191295ee53f438b84a71eeb5",
                "checks": [
                    {"timestamp": "2026-08-28T23:06:35.734Z", "command": "pkexec /usr/bin/docker build -t autoseguro-meta-validation $WORKTREE", "exit_code": 0, "result": "image build passed", "source_record": 217},
                    {"timestamp": "2026-08-29T00:31:41.301Z", "command": "npm run check", "exit_code": 0, "tests": 33, "passed": 33, "failed": 0, "source_record": 612},
                ],
                "source": "../sessions/2026-08-28-meta-pilot.jsonl",
            },
            {
                "pull_request": f"{PUBLIC_REPOSITORY}/pull/3",
                "merge_commit": "67052b8eaaa81b535868d5e18353e6ba68c7901f",
                "final_source_commit": "193e547d050b59d626215b0c3dfdeee98b968b25",
                "checks": [
                    {"timestamp": "2026-08-29T08:27:13.375Z", "command": "npm run typecheck", "exit_code": 2, "result": "syntax errors found and corrected", "source_record": 90},
                    {"timestamp": "2026-08-29T08:29:33.717Z", "command": "npm test", "exit_code": 0, "tests": 33, "passed": 33, "failed": 0, "source_record": 130},
                    {"timestamp": "2026-08-29T09:06:22.809Z", "command": "npm run check", "exit_code": 0, "tests": 42, "passed": 42, "failed": 0, "source_record": 368},
                    {"timestamp": "2026-08-29T11:56:27.662Z", "command": "npm run check", "exit_code": 0, "tests": 49, "passed": 49, "failed": 0, "source_record": 762},
                    {"timestamp": "2026-08-29T12:33:51.094Z", "command": "npm run check", "exit_code": 0, "tests": 49, "passed": 49, "failed": 0, "source_record": 774},
                ],
                "limitation": "The final unbiased live WhatsApp journey was not run in PR 3. The worker stated this explicitly.",
                "source": "../sessions/2026-08-29-whatsapp-ux.jsonl",
            },
            {
                "pull_request": f"{PUBLIC_REPOSITORY}/pull/4",
                "merge_commit": "2a3e288eaf9218c8ac05b8c36270b97d1e18f0c1",
                "builder_commit": "ee0ac2e838f0be4d62ccf48b55057419433f02ae",
                "checks": [
                    {"timestamp": "2026-08-29T12:42:32.194Z", "command": "npm run check", "exit_code": 0, "tests": 49, "passed": 49, "failed": 0, "source_record": 81},
                    {"timestamp": "2026-08-29T13:40:03.037Z", "finished_at": "2026-08-29T13:41:19.278Z", "command": "node .cursor/skills/verify-autoseguro/verify.mjs --run-id proof-full-final", "exit_code": 0, "journeys": 200, "families": 10, "source_records": [417, 418]},
                    {"timestamp": "2026-08-29T13:45:39.069Z", "command": "npm run check", "exit_code": 0, "tests": 49, "passed": 49, "failed": 0, "source_record": 455},
                    {"timestamp": "2026-08-29T13:48:51.393Z", "command": "node .cursor/skills/verify-autoseguro/verify.mjs --feature greeting-plan-selection --run-id proof-mapped-ee0ac2e", "harness_result": "passed one journey", "wrapper_exit_code": 1, "wrapper_failure": "the follow-on jq commit assertion was malformed", "source_record": 479},
                ],
                "source": "../sessions/2026-08-29-verification-skill-builder.jsonl",
            },
        ],
    }


def reliability_summary():
    source = json.loads((ROOT / "examples/evaluation/reliability-100.json").read_text(encoding="utf-8"))
    omitted_rows = {
        "reliability_conversations": source["reliability"]["conversations"],
        "language_conversations": source["language"]["conversations"],
    }
    omitted_bytes = json.dumps(omitted_rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return {
        "schema_version": 1,
        "title": "Seeded reliability campaign",
        "timestamp": source["generated_at"],
        "command": "npm run evaluate -- --conversations 100 --concurrency 10 --language-conversations 20 --language-concurrency 2 --output examples/evaluation/reliability-100.json",
        "commit": "b7ef112bd169ff9d94a265d913e4526f62bb1c65",
        "exit_code": 0,
        "configuration": source["quote_api_configuration"],
        "concurrency": source["concurrency"],
        "language_concurrency": source["language_concurrency"],
        "reliability": {name: value for name, value in source["reliability"].items() if name != "conversations"},
        "language": {name: value for name, value in source["language"].items() if name != "conversations"},
        "gates": source["gates"],
        "source_links": ["../../examples/evaluation/reliability-100.json", "../../examples/evaluation/reliability-100.md", f"{PUBLIC_REPOSITORY}/commit/b7ef112bd169ff9d94a265d913e4526f62bb1c65"],
        "omission": {"type": "aggregate_only", "reliability_conversation_rows": len(source["reliability"]["conversations"]), "language_rows": len(source["language"]["conversations"]), "source_fragment_sha256": sha256_bytes(omitted_bytes), "source_bytes": len(omitted_bytes), "hash_basis": "canonical-json-subset"},
        "limitations": ["The campaign used one seeded run, not a confidence interval.", "The LLM pass used the configured Ollama Cloud model and is not deterministic across future provider versions."],
    }


def real_conversation_summary():
    rows = [json.loads(line) for line in (ROOT / "examples/conversation-real.audit.jsonl").read_text(encoding="utf-8").splitlines() if line]
    attempts = [{"attempt": row["attempt"], "latency_ms": row["latency_ms"], "http_status": row["http_status"], "failure_kind": row["failure_kind"], "outcome": row["outcome"]} for row in rows if row["event"] == "quote_attempt"]
    return {
        "schema_version": 1,
        "title": "Real Ollama Cloud and official quote-service conversation",
        "started_at": rows[0]["timestamp"],
        "finished_at": rows[-1]["timestamp"],
        "command": "STATE_DIR=.runtime/demo-state AUDIT_LOG_PATH=.runtime/demo-audit.jsonl npm run chat -- --conversation demo-real-20260828 --replay examples/conversation-input.jsonl --reset",
        "commit": "b2f3746d3dc98e08533a52191461dd28c2d3945d",
        "exit_code": 0,
        "model": "deepseek-v4-flash:0731",
        "quote_service_commit": "b617ef83b736b90b94bf145b554b5cb3128f518b",
        "outcome": "resolved",
        "attempts": attempts,
        "facts": {"pending_reply_before_final": True, "official_price_only": True, "personal_data_in_script": False},
        "source_links": ["../../examples/conversation-real.md", "../../examples/conversation-real.audit.jsonl", f"{PUBLIC_REPOSITORY}/commit/b2f3746d3dc98e08533a52191461dd28c2d3945d"],
        "limitation": "This is one real LLM conversation and one seeded official quote-service path.",
    }


def meta_summary(scrubber):
    source = json.loads((ROOT / "docs/meta-provisioning-evidence.json").read_text(encoding="utf-8"))
    value = {
        "schema_version": 1,
        "title": "Meta provisioning and live test-WABA proof",
        "timestamp": source["verified_at"],
        "commands": ["npm run meta:provision -- --apply", "npm run meta:smoke", "manual allowlisted WhatsApp round trip"],
        "commit": "c3ea8a8b66e95ce2191295ee53f438b84a71eeb5",
        "merge_commit": "47bb14c8808a44d140ff4c866897781ac646e5da",
        "exit_result": "passed",
        "deployment": source["deployment"],
        "test_waba": {"subscription_count": source["test_waba"]["subscription_count"], "override_active": True},
        "test_phone": {name: source["test_phone"][name] for name in ("quality", "verification", "status", "registered_at")},
        "canonical_isolation": {"default_callback_unchanged": source["app"]["unchanged"], "waba_override_present": source["canonical_phone"]["waba_override_present"]},
        "live_round_trip": {"status": source["live_round_trip"]["status"], "collection": {name: source["live_round_trip"]["collection"][name] for name in ("received_at", "reply_at", "reply_latency_ms", "outcome")}, "quote": {name: source["live_round_trip"]["quote"][name] for name in ("received_at", "acknowledged_at", "acknowledgement_ms", "final_at", "final_after_ack_ms", "quote_attempts", "attempt_http_statuses", "outcome", "fabricated_price")}, "privacy": source["live_round_trip"]["privacy"], "handoff_live_proof": source["live_round_trip"]["handoff_live_proof"]},
        "source_links": ["../../docs/meta-provisioning-evidence.json", f"{PUBLIC_REPOSITORY}/pull/2"],
        "limitations": ["The live handoff path was not run on Meta; deterministic local coverage handled it.", "Private hosts and all Meta account, app, phone, message, and recipient identifiers are excluded."],
    }
    return scrubber.obj(value)


def builder_summary():
    scenarios = json.loads((ROOT / ".cursor/skills/verify-autoseguro/scenarios.json").read_text(encoding="utf-8"))
    return {
        "schema_version": 1,
        "title": "Verification-skill builder campaign",
        "command": "node .cursor/skills/verify-autoseguro/verify.mjs --run-id proof-full-final",
        "started_at": "2026-08-29T13:40:03.037Z",
        "finished_at": "2026-08-29T13:41:19.278Z",
        "source_commit": "67052b8eaaa81b535868d5e18353e6ba68c7901f",
        "builder_commit": "ee0ac2e838f0be4d62ccf48b55057419433f02ae",
        "merge_commit": "2a3e288eaf9218c8ac05b8c36270b97d1e18f0c1",
        "exit_code": 0,
        "journeys": scenarios["journey_count"],
        "families": {family["id"]: len(family["journeys"]) for family in scenarios["families"]},
        "local_check": {"command": "npm run check", "tests": 49, "passed": 49, "failed": 0, "exit_code": 0, "timestamp": "2026-08-29T13:45:39.069Z"},
        "post_commit_probe": {"harness": "passed one greeting-plan-selection journey", "wrapper_exit_code": 1, "reason": "a malformed follow-on jq commit assertion failed after the harness PASS"},
        "source_links": ["../sessions/2026-08-29-verification-skill-builder.jsonl", "../../.cursor/skills/verify-autoseguro/SKILL.md", f"{PUBLIC_REPOSITORY}/pull/4"],
        "limitations": ["This was the harness author's campaign.", "Detailed ignored evidence stayed under the worker's local .artifacts directory and was not copied into Git."],
    }


def fresh_summary():
    check_meta = json.loads((BUILD / "fresh-npm-check.json").read_text(encoding="utf-8"))
    check_log = (BUILD / "fresh-npm-check.log").read_text(encoding="utf-8")
    campaign = json.loads((ROOT / ".artifacts/verify-autoseguro/ai-logs-fresh-final/summary.json").read_text(encoding="utf-8"))
    match = re.search(r"ℹ tests (\d+).*?ℹ pass (\d+).*?ℹ fail (\d+)", check_log, re.S)
    if not match:
        raise RuntimeError("fresh npm check counts unavailable")
    if check_meta["exit_code"] != 0 or campaign["status"] != "passed" or campaign["journeys"] != 200:
        raise RuntimeError("fresh validation did not pass")
    scratch = ROOT / ".artifacts/verify-autoseguro/ai-logs-fresh-final/.scratch"
    index = ROOT / ".artifacts/verify-autoseguro/ai-logs-fresh-final/index.md"
    if scratch.exists() or not index.is_file():
        raise RuntimeError("fresh verification cleanup/evidence gate failed")
    return {
        "schema_version": 1,
        "title": "Fresh final validation",
        "npm_check": {**check_meta, "tests": int(match.group(1)), "passed": int(match.group(2)), "failed": int(match.group(3))},
        "verification": {
            "command": "node .cursor/skills/verify-autoseguro/verify.mjs --run-id ai-logs-fresh-final",
            "exit_code": 0,
            "status": campaign["status"],
            "started_at": campaign["started_at"],
            "finished_at": campaign["finished_at"],
            "build": campaign["build"],
            "journeys": campaign["journeys"],
            "coverage": campaign["coverage"],
            "scratch_removed": True,
            "evidence_index_preserved": True,
        },
        "source_links": ["../../.cursor/skills/verify-autoseguro/SKILL.md", "../../.cursor/skills/verify-autoseguro/scenarios.json"],
        "limitations": ["The verifier uses deterministic loopback substitutes for Meta Graph, the quote boundary, and the LLM.", "The ignored detailed evidence remains local under .artifacts and is not part of this public package."],
    }


def write_results(denyset, commits):
    entries = []
    write_json(OUTPUT / "results/historical-local-checks.json", historical_checks())
    write_json(OUTPUT / "results/real-quote-conversation.json", real_conversation_summary())
    for path in RESULT_SOURCES["real-conversation"]:
        entries.append(source_entry(f"real-conversation:{path.name}", path, "ai-logs/results/real-quote-conversation.json", retained=1, omissions=0))
    reliability_scrubber = Scrubber(denyset, commits)
    write_json(OUTPUT / "results/reliability-100.json", reliability_scrubber.obj(reliability_summary()))
    for index, path in enumerate(RESULT_SOURCES["reliability-100"]):
        omitted = 120 if path.suffix == ".json" else 3
        entries.append(source_entry(f"reliability-100:{path.name}", path, "ai-logs/results/reliability-100.json", reliability_scrubber if index == 0 else None, retained=1, omissions=omitted))
    meta_scrubber = Scrubber(denyset, commits)
    write_json(OUTPUT / "results/meta-live-proof.json", meta_summary(meta_scrubber))
    entries.append(source_entry("meta-provisioning-live-proof", RESULT_SOURCES["meta-live-proof"][0], "ai-logs/results/meta-live-proof.json", meta_scrubber, retained=1, omissions=4))
    write_json(OUTPUT / "results/verification-builder-200.json", builder_summary())
    for path in RESULT_SOURCES["verification-skill"]:
        entries.append(source_entry(f"verification-skill:{path.relative_to(ROOT)}", path, "ai-logs/results/verification-builder-200.json", retained=1, omissions=0))
    report_path = RESULT_SOURCES["independent-audit-report"][0]
    report_scrubber = Scrubber(denyset, commits)
    report_body = report_scrubber.text(report_path.read_text(encoding="utf-8"))
    report = "# Independent Audit: AutoSeguro E2E Verification Skill\n\n## Public export provenance\n\n- Started: `2026-08-29T14:17:20.661Z`\n- Finished: `2026-08-29T14:18:43.151Z`\n- Exit result: `PASS`\n- Session: [`2026-08-29-independent-audit.jsonl`](../sessions/2026-08-29-independent-audit.jsonl)\n- Public implementation: " + PUBLIC_REPOSITORY + "/commit/2a3e288eaf9218c8ac05b8c36270b97d1e18f0c1\n\n" + report_body.split("\n", 2)[2]
    (OUTPUT / "results/independent-audit-200.md").write_text(report, encoding="utf-8")
    entries.append(source_entry("independent-audit-report", report_path, "ai-logs/results/independent-audit-200.md", report_scrubber, retained=1, omissions=0))
    write_json(OUTPUT / "results/fresh-validation.json", fresh_summary())
    for group in ("fresh-npm-check", "fresh-verification"):
        for path in RESULT_SOURCES[group]:
            entries.append(source_entry(f"{group}:{path.name}", path, "ai-logs/results/fresh-validation.json", retained=1, omissions=0))
    return [entry for entry in entries if entry]


def readme_text(main_cutoff):
    return f"""# Public AI work log

This package records the AI-assisted work that produced AutoSeguro for the KHAL challenge. It contains normalized exports, not raw provider or agent logs. The shipped product is the implementation in PRs [#1]({PUBLIC_REPOSITORY}/pull/1), [#2]({PUBLIC_REPOSITORY}/pull/2), [#3]({PUBLIC_REPOSITORY}/pull/3), and [#4]({PUBLIC_REPOSITORY}/pull/4).

## Scope and chronology

1. [2026-08-27 Cursor MVP summary](sessions/2026-08-27-cursor-mvp-superseded.jsonl) — superseded and not shipped. Only its existing summary was available.
2. [Main Firstmate orchestration](sessions/2026-08-28-main-orchestration.jsonl) — the KHAL interval from the first challenge request through this export dispatch.
3. [Core implementation](sessions/2026-08-28-core-implementation.jsonl) — PR 1, the real quote conversation, and reliability work.
4. [Meta pilot](sessions/2026-08-28-meta-pilot.jsonl) — PR 2 and the isolated test-WABA proof.
5. [WhatsApp UX](sessions/2026-08-29-whatsapp-ux.jsonl) — PR 3.
6. [Verification-skill builder](sessions/2026-08-29-verification-skill-builder.jsonl) — PR 4 and the first 200-journey campaign.
7. [Independent audit](sessions/2026-08-29-independent-audit.jsonl) — a clean-context rerun and review.

Each JSONL file is UTF-8 and chronological. Records preserve human prompts, visible assistant text, tool names, sanitized arguments and results, timestamps, public links, and public commits. Omitted material appears as a typed record with a SHA-256 digest, byte count, and hash basis.

## Results

- [Historical local checks for PRs 1–4](results/historical-local-checks.json)
- [Real LLM and quote-service conversation](results/real-quote-conversation.json)
- [Seeded reliability campaign: 100 conversations](results/reliability-100.json)
- [Meta provisioning and live test-WABA proof](results/meta-live-proof.json)
- [Verification builder: 200 journeys](results/verification-builder-200.json)
- [Independent 200-journey audit](results/independent-audit-200.md)
- [Fresh final check and 200-journey rerun](results/fresh-validation.json)

The committed source artifacts remain at [`examples/conversation-real.md`](../examples/conversation-real.md), [`examples/evaluation/reliability-100.md`](../examples/evaluation/reliability-100.md), [`docs/meta-provisioning-evidence.json`](../docs/meta-provisioning-evidence.json), and [`.cursor/skills/verify-autoseguro/`](../.cursor/skills/verify-autoseguro/).

## Redaction policy

The exporter builds an in-memory exact denyset from secret-bearing fields in `$HOME/.pi/agent/.env`, `$HOME/.pi/agent/auth.json`, and its process environment. It never prints those values. It then removes credentials, authorization material, cookies, JWTs, private keys, authentication URLs, personal contact data, CPF-like values, Meta identifiers, local user and terminal identifiers, private hosts, absolute local paths, UUIDs, and unknown high-entropy blobs. Useful local paths become `$HOME`, `$PROJECT`, or `$WORKTREE`. Public GitHub URLs and commits remain.

Hidden reasoning, internal instructions, watcher traffic, unrelated project discussion, binary content, duplicate transport records, candidate-dossier excerpts, and oversized tool payloads are not published. Their omission markers preserve hashes and byte counts. The candidate dossier itself is not an export source.

When a match is uncertain, the exporter redacts it. The manifest reports redaction counts by category for each source.

## Known omissions and limits

- The Cursor artifact was already a 1,093-byte summary. Its raw transcript was not copied or reconstructed.
- The main session is fixed at byte cutoff `{main_cutoff}`. Records before the first KHAL request are represented by one omission marker. Later appends cannot enter this export.
- Per-journey reliability and verifier traces are summarized to keep the package proportionate. Their aggregate counts and source hashes remain.
- Historical command output is reported only where the source sessions contain it. Missing historical stdout is marked as unavailable rather than recreated.
- Private Meta identifiers, hosts, phones, message hashes, and credentials are absent even when they appeared in an otherwise useful proof.

## Regeneration

The exporter reads exactly six session paths from ignored `.runtime/ai-logs-build/source-map.json`, keyed as `main-orchestration`, `core-implementation`, `meta-pilot`, `whatsapp-ux`, `verification-skill-builder`, and `independent-audit`. An authorized source holder creates that private JSON map from the inventory above. The exporter rejects extra keys, wrong timestamp prefixes, wrong hashes, duplicates, and paths outside `$HOME/.pi/agent/sessions/`. It does not search the home directory or stage a raw log in the repository.

```bash
mkdir -p .runtime/ai-logs-build
started=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
set +e
npm run check >.runtime/ai-logs-build/fresh-npm-check.log 2>&1
code=$?
set -e
finished=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
python - "$started" "$finished" "$code" <<'PY'
import json, pathlib, sys
pathlib.Path('.runtime/ai-logs-build/fresh-npm-check.json').write_text(json.dumps({{'command':'npm run check','started_at':sys.argv[1],'finished_at':sys.argv[2],'exit_code':int(sys.argv[3])}}, indent=2) + '\\n')
PY
rm -rf .artifacts/verify-autoseguro/ai-logs-fresh-final
node .cursor/skills/verify-autoseguro/verify.mjs --run-id ai-logs-fresh-final
python scripts/export-ai-logs.py --main-cutoff {main_cutoff} --source-map .runtime/ai-logs-build/source-map.json
```

The command fails on a changed allowlisted session, an ambiguous worker-role mapping, invalid JSONL, a missing fresh proof, a surviving scratch directory, an exact source secret, a forbidden pattern, or an undocumented high-entropy token. Private build metadata is written only to ignored `.runtime/ai-logs-build/export.json`.
"""


def collect_documented_hashes():
    allowed = set(public_commits()) | {VERIFY_FINGERPRINT}

    def visit(item, key=""):
        if isinstance(item, dict):
            for name, child in item.items():
                visit(child, name)
        elif isinstance(item, list):
            for child in item:
                visit(child, key)
        elif isinstance(item, str) and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", item, re.I):
            if key in {"source_sha256", "source_fragment_sha256", "source_prefix_sha256", "commit", "merge_commit", "final_source_commit", "builder_commit", "quote_service_commit", "sha", "fingerprint"}:
                allowed.add(item)

    for path in OUTPUT.rglob("*"):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            visit(json.loads(text))
        elif path.suffix == ".jsonl":
            for line in text.splitlines():
                visit(json.loads(line))
    return allowed


def scan_outputs(denyset):
    failures = []
    high_entropy = []
    patterns = {
        "absolute_home_path": re.compile(r"/home/" + re.escape(os.environ.get("USER", "<local-user>")) + r"(?:/|\b)"),
        "private_key": re.compile(r"-----BEGIN [^-]+ PRIVATE KEY-----", re.I),
        "authorization": re.compile(r"(?im)\bauthorization[\"']?\s*[:=]\s*(?!<[^>]*redacted>)[^\s,;}\"']+"),
        "cookie": re.compile(r"(?im)\b(?:set-)?cookie\s*[:=]\s*(?!<[^>]*redacted>)[^\r\n]+"),
        "bearer": re.compile(r"\bBearer\s+(?!<)[A-Za-z0-9._~+/=-]{8,}", re.I),
        "api_key": re.compile(r"\b(?:sk|pk)[-_][A-Za-z0-9_-]{16,}\b", re.I),
        "meta_token": re.compile(r"\bEAA[A-Za-z0-9_-]{16,}\b"),
        "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
        "tailscale_login": re.compile(r"https?://login\.tailscale\.com/\S+", re.I),
        "oauth_url": re.compile(r"https?://[^\s'\"]*(?:oauth|authorize)[^\s'\"]*", re.I),
        "whatsapp_jid": re.compile(r"\b\d{7,16}@(s\.whatsapp\.net|c\.us|g\.us)\b", re.I),
        "email": re.compile(r"(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.-])"),
        "cpf": re.compile(r"(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)"),
        "phone": re.compile(r"(?<![\w-])(?:\+\d{8,15}|\d{10,17}|(?:\(?\d{2}\)?[ .-]?)?9?\d{4}[ .-]\d{4})(?![\w-])"),
        "masked_identifier": re.compile(r"\*{4,}\d{3,6}"),
        "session_identifier": re.compile(r"(?<![0-9a-f])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-f])", re.I),
        "private_host": re.compile(r"(?:[A-Za-z0-9-]+\.)*triangulotec\.com\.br", re.I),
        "credential_assignment": re.compile(r"(?i)(?:\b(?:api[_-]?key|access[_-]?token|app[_-]?secret|verify[_-]?token|webhook[_-]?secret|password|pin)\s*=|[\"'](?:api[_-]?key|access[_-]?token|app[_-]?secret|verify[_-]?token|webhook[_-]?secret|password|pin)[\"']\s*:)[\"']?\s*(?!<[^>]*redacted>|\$\{)[^\s,;}\"']+"),
    }
    if os.environ.get("USER"):
        patterns["local_username"] = re.compile(rf"(?<![\w/]){re.escape(os.environ['USER'])}(?![\w])", re.I)
    files = [path for path in OUTPUT.rglob("*") if path.is_file()]

    def strings(value):
        if isinstance(value, dict):
            for child in value.values():
                yield from strings(child)
        elif isinstance(value, list):
            for child in value:
                yield from strings(child)
        elif isinstance(value, str):
            yield value

    values_by_path = {}
    for path in files:
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            failures.append((str(path.relative_to(ROOT)), "invalid_utf8"))
            continue
        for secret in denyset:
            if secret.encode() in raw:
                failures.append((str(path.relative_to(ROOT)), "exact_secret"))
        parsed_values = []
        if path.suffix == ".jsonl":
            previous = ""
            for line_number, line in enumerate(text.splitlines(), 1):
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    failures.append((str(path.relative_to(ROOT)), f"invalid_jsonl:{line_number}"))
                    continue
                parsed_values.extend(strings(value))
                timestamp = value.get("timestamp", "") if isinstance(value, dict) else ""
                if timestamp and previous and timestamp < previous:
                    failures.append((str(path.relative_to(ROOT)), f"non_chronological:{line_number}"))
                previous = timestamp or previous
        elif path.suffix == ".json":
            try:
                value = json.loads(text)
                parsed_values.extend(strings(value))
            except json.JSONDecodeError:
                failures.append((str(path.relative_to(ROOT)), "invalid_json"))
        else:
            parsed_values.append(text)
        values_by_path[path] = parsed_values
        for value in parsed_values:
            scan_value = re.sub(r"\b(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})\b", "<documented-hash>", value, flags=re.I)
            for name, pattern in patterns.items():
                if pattern.search(scan_value):
                    failures.append((str(path.relative_to(ROOT)), name))
    allowed = collect_documented_hashes()
    token_pattern = re.compile(r"(?<![\w])(?=[A-Za-z0-9_+=-]{28,}(?![\w]))[A-Za-z0-9_+=-]+")
    for path, values in values_by_path.items():
        for text in values:
            for match in re.finditer(r"\b(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})\b", text, re.I):
                token = match.group(0)
                if token not in allowed:
                    high_entropy.append((str(path.relative_to(ROOT)), sha256_bytes(token.encode())))
            for match in token_pattern.finditer(text):
                token = match.group(0)
                if token in allowed or re.fullmatch(r"[a-z]+(?:-[a-z0-9]+)+", token) or re.match(r"^\d{4}-\d{2}-\d{2}", token):
                    continue
                frequencies = collections.Counter(token)
                entropy = -sum((count / len(token)) * math.log2(count / len(token)) for count in frequencies.values())
                classes = sum(bool(re.search(pattern, token)) for pattern in (r"[a-z]", r"[A-Z]", r"\d", r"[_+/=]"))
                if entropy >= 4.2 and classes >= 2:
                    high_entropy.append((str(path.relative_to(ROOT)), sha256_bytes(token.encode())))
    if failures or high_entropy:
        details = [f"{path}:{category}" for path, category in sorted(set(failures))]
        details += [f"{path}:high_entropy:{fingerprint}" for path, fingerprint in sorted(set(high_entropy))]
        raise RuntimeError("public-safety scan failed\n" + "\n".join(details))


def write_private_build(main_cutoff, manifest):
    BUILD.mkdir(parents=True, exist_ok=True)
    value = {
        "recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "main_source_absolute_path": str(MAIN["path"]),
        "main_source_observed_bytes": MAIN["path"].stat().st_size,
        "main_source_byte_cutoff": main_cutoff,
        "main_source_prefix_sha256": MAIN_CUTOFF_SHA256,
        "manifest_sha256": sha256_bytes((OUTPUT / "manifest.json").read_bytes()),
        "source_count": len(manifest["sources"]),
    }
    write_json(BUILD / "export.json", value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--main-cutoff", type=int, required=True)
    parser.add_argument("--source-map", type=Path, default=BUILD / "source-map.json")
    args = parser.parse_args()
    if args.main_cutoff <= 0:
        raise RuntimeError("main cutoff must be positive")
    bind_source_map(args.source_map)
    main_raw = source_bytes(MAIN["path"], args.main_cutoff)
    if sha256_bytes(main_raw) != MAIN_CUTOFF_SHA256:
        raise RuntimeError("main session cutoff does not match the declared snapshot")
    verify_worker_mapping()
    denyset = secret_values()
    commits = public_commits()
    if OUTPUT.exists():
        for child in OUTPUT.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    (OUTPUT / "sessions").mkdir(parents=True)
    (OUTPUT / "results").mkdir(parents=True)
    manifest_entries = [export_cursor(denyset, commits)]
    manifest_entries.append(export_session(MAIN, denyset, commits, args.main_cutoff, MAIN_START_RECORD))
    manifest_entries.extend(export_session(item, denyset, commits) for item in WORKERS)
    manifest_entries.extend(write_results(denyset, commits))
    (OUTPUT / "README.md").write_text(readme_text(args.main_cutoff), encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "main_session_boundary": {"start_record": MAIN_START_RECORD, "byte_cutoff": args.main_cutoff, "source_prefix_sha256": MAIN_CUTOFF_SHA256},
        "source_policy": "fixed allowlist; no home-directory discovery",
        "sources": manifest_entries,
    }
    write_json(OUTPUT / "manifest.json", manifest)
    scan_outputs(denyset)
    write_private_build(args.main_cutoff, manifest)
    print(f"PASS: exported {len(manifest_entries)} allowlisted sources; public-safety scan clean")


if __name__ == "__main__":
    main()
