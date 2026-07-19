#!/usr/bin/env python3
"""Small, dependency-free telemetry and provider runner for model-orchestrator."""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import html
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    tomllib = None


ROOT = Path.cwd()
SENSITIVE = re.compile(r"(?i)(api[_-]?key|token|secret|password|authorization)(\s*[=:]\s*)([^\s,;\"']+)")
BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def redact(value: str) -> str:
    value = BEARER.sub("Bearer [REDACTED]", value)
    return SENSITIVE.sub(lambda m: m.group(1) + m.group(2) + "[REDACTED]", value)


def load_config(root: Path) -> dict:
    path = root / ".orchestrator" / "config.toml"
    if path.exists() and tomllib:
        with path.open("rb") as f:
            return tomllib.load(f)
    return {
        "roles": {"director_broad": "fable-5", "director_technical": "sol-5.6", "implementer": "codex-medium", "reviewer": "cursor-review"},
        "models": {}, "providers": {}, "pricing": {},
        "budgets": {"max_estimated_cost_usd": 5.0, "max_repair_cycles": 3, "max_stage_duration_minutes": 30},
    }


def paths(root: Path) -> tuple[Path, Path]:
    d = root / ".orchestrator"
    d.mkdir(parents=True, exist_ok=True)
    return d, d / "ledger.jsonl"


def read_ledger(root: Path) -> list[dict]:
    _, path = paths(root)
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def append_record(root: Path, record: dict) -> None:
    _, path = paths(root)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, sort_keys=True) + "\n")


def parse_events(text: str) -> tuple[dict, bool]:
    """Return normalized usage from JSON or JSONL; tolerate provider prose."""
    objects = []
    seen = set()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                marker = obj.get("event_id") or obj.get("id") or json.dumps(obj, sort_keys=True)
                if marker not in seen:
                    seen.add(marker); objects.append(obj)
        except json.JSONDecodeError:
            pass
    if not objects:
        try:
            obj = json.loads(text)
            objects = [obj] if isinstance(obj, dict) else []
        except json.JSONDecodeError:
            pass
    usage: dict = {}
    cost = None
    exact = False
    request_id = None
    api_duration = None
    for obj in objects:
        u = obj.get("usage") if isinstance(obj.get("usage"), dict) else obj
        aliases = {
            "input_tokens": ("input_tokens", "prompt_tokens", "inputTokens"),
            "output_tokens": ("output_tokens", "completion_tokens", "outputTokens"),
            "total_tokens": ("total_tokens", "totalTokens"),
            "cache_read_tokens": ("cache_read_tokens", "cache_read_input_tokens", "cacheReadInputTokens"),
            "reasoning_tokens": ("reasoning_tokens", "reasoningTokens"),
        }
        for dest, keys in aliases.items():
            for key in keys:
                if key in u and isinstance(u[key], (int, float)):
                    usage[dest] = usage.get(dest, 0) + u[key]
                    break
        for key in ("cost_usd", "cost", "total_cost", "totalCost"):
            if isinstance(obj.get(key), (int, float)):
                cost = obj[key]; exact = True
        request_id = request_id or obj.get("request_id") or obj.get("requestId") or obj.get("session_id")
        api_duration = api_duration or obj.get("api_duration_seconds") or obj.get("api_duration_ms")
    if api_duration and api_duration > 1000: api_duration = api_duration / 1000
    if "total_tokens" not in usage and "input_tokens" in usage and "output_tokens" in usage:
        usage["total_tokens"] = usage["input_tokens"] + usage["output_tokens"]
    return {"usage": usage, "provider_cost_usd": cost, "cost_exact": exact, "request_id": request_id, "api_duration_seconds": api_duration, "parsed": bool(objects)}, bool(objects)


def estimate(usage: dict, model: str, config: dict) -> float | None:
    rates = config.get("pricing", {}).get(model) or config.get("pricing", {}).get("default")
    if not isinstance(rates, dict): return None
    inp = usage.get("input_tokens", 0) * float(rates.get("input_per_1m", 0)) / 1_000_000
    out = usage.get("output_tokens", 0) * float(rates.get("output_per_1m", 0)) / 1_000_000
    return round(inp + out, 8) if usage else None


def command_for(args, config: dict) -> str | None:
    if args.command: return args.command
    provider = config.get("providers", {}).get(args.provider, {})
    if isinstance(provider, str): return provider
    return provider.get("command") if isinstance(provider, dict) else None


def run_stage(args) -> int:
    root = Path(args.root).resolve(); orch, _ = paths(root); config = load_config(root)
    requested_model = args.model
    model_spec = config.get("models", {}).get(args.model, args.model) if args.model else ""
    resolved_model = model_spec.get("model", args.model) if isinstance(model_spec, dict) else model_spec
    run_id = args.run_id or uuid.uuid4().hex[:12]
    run_dir = orch / "runs" / run_id; raw_dir = run_dir / "raw"; raw_dir.mkdir(parents=True, exist_ok=True)
    checkpoint = run_dir / "checkpoint.json"
    if args.resume and checkpoint.exists():
        old = json.loads(checkpoint.read_text())
        if old.get("stage") == args.stage and old.get("status") == "success":
            print(json.dumps({"resumed": True, "run_id": run_id, "stage": args.stage})); return 0
    packet = Path(args.input).read_text(encoding="utf-8") if args.input else ""
    task_file = run_dir / "task.md"
    if packet and not task_file.exists(): task_file.write_text(packet, encoding="utf-8")
    command = command_for(args, config)
    start = time.monotonic(); started = now()
    checkpoint.write_text(json.dumps({"run_id": run_id, "stage": args.stage, "status": "running", "started_at": started}, indent=2))
    try:
        if not command: raise RuntimeError(f"No command configured for provider {args.provider!r}")
        values = {"task_id": args.task_id, "run_id": run_id, "stage": args.stage, "model": resolved_model or "", "input_file": str(task_file), "run_dir": str(run_dir)}
        # Replace only our documented placeholders; provider JSON commonly contains
        # braces, so str.format would corrupt otherwise-valid commands.
        for key, value in values.items():
            command = command.replace("{" + key + "}", value)
        proc = subprocess.run(command, input=packet, text=True, capture_output=True, timeout=args.timeout, shell=True, cwd=root, env=os.environ.copy())
        exit_code = proc.returncode; out = redact(proc.stdout); err = redact(proc.stderr)
    except subprocess.TimeoutExpired as e:
        exit_code = 124; out = redact((e.stdout or "") if isinstance(e.stdout, str) else ""); err = redact((e.stderr or "") if isinstance(e.stderr, str) else "") + "\n[timeout]"
    except Exception as e:
        exit_code = 1; out = ""; err = redact(str(e))
    raw_out = raw_dir / f"{args.stage}-{int(time.time())}.stdout"; raw_err = raw_dir / f"{args.stage}-{int(time.time())}.stderr"
    raw_out.write_text(out, encoding="utf-8"); raw_err.write_text(err, encoding="utf-8")
    parsed, has_json = parse_events(out)
    usage = parsed["usage"]; provider_cost = parsed["provider_cost_usd"]; estimate_usd = None if provider_cost is not None else estimate(usage, resolved_model or "", config)
    status = "exact" if provider_cost is not None else "estimated" if estimate_usd is not None else "unavailable"
    record = {"task_id": args.task_id, "run_id": run_id, "stage": args.stage, "provider": args.provider, "requested_model": requested_model, "resolved_model": resolved_model, "session_id": parsed["request_id"], "started_at": started, "ended_at": now(), "duration_seconds": round(time.monotonic() - start, 4), "api_duration_seconds": parsed["api_duration_seconds"], **usage, "provider_cost_usd": provider_cost, "rate_card_estimate_usd": estimate_usd, "cost_status": status, "exit_code": exit_code, "success": exit_code == 0, "raw_output_path": str(raw_out.relative_to(root)), "error_path": str(raw_err.relative_to(root)), "parsed_json": has_json, "cli_version": args.cli_version}
    append_record(root, record)
    checkpoint.write_text(json.dumps({"run_id": run_id, "stage": args.stage, "status": "success" if exit_code == 0 else "failed", "recorded_at": record["ended_at"], "record": record}, indent=2))
    print(json.dumps(record, indent=2))
    return exit_code


def summarize(rows: list[dict], group: str | None = None) -> dict:
    def one(items):
        runs = {x.get("run_id") for x in items}
        repair = sum(1 for x in items if str(x.get("stage", "")).lower().startswith(("repair", "retry")))
        return {"stages": len(items), "runs": len(runs), "successful_stages": sum(bool(x.get("success")) for x in items), "failed_stages": sum(not x.get("success") for x in items), "retried_stages": max(0, len(items) - len({(x.get("run_id"), x.get("stage")) for x in items})), "repair_cycles": repair, "total_tokens": sum(x.get("total_tokens") or 0 for x in items), "exact_cost_usd": round(sum(x.get("provider_cost_usd") or 0 for x in items), 8), "estimated_cost_usd": round(sum(x.get("rate_card_estimate_usd") or 0 for x in items), 8), "unavailable_cost_stages": sum(x.get("cost_status") == "unavailable" for x in items), "duration_seconds": round(sum(x.get("duration_seconds") or 0 for x in items), 4)}
    if group: return {str(k): one([x for x in rows if x.get(group) == k]) for k in sorted({x.get(group) for x in rows})}
    return one(rows)


def export_cmd(args) -> int:
    rows = read_ledger(Path(args.root)); data = rows if args.format == "json" else None
    if args.format == "json": print(json.dumps(rows, indent=2))
    else:
        fields = ["task_id", "run_id", "stage", "provider", "resolved_model", "duration_seconds", "total_tokens", "provider_cost_usd", "rate_card_estimate_usd", "cost_status", "exit_code", "success"]
        w = csv.DictWriter(sys.stdout, fieldnames=fields); w.writeheader(); w.writerows({k: r.get(k) for k in fields} for r in rows)
    return 0


def dashboard(args) -> int:
    root = Path(args.root); rows = read_ledger(root); out = root / ".orchestrator" / "dashboard.html"
    payload = json.dumps({"rows": rows, "summary": summarize(rows)})
    body = """<!doctype html><meta charset=utf-8><title>Model Orchestrator</title><style>body{font:14px system-ui;margin:2em}table{border-collapse:collapse}td,th{padding:.4em;border:1px solid #ccc}code{font-size:12px}</style><h1>Model Orchestrator</h1><pre id=s></pre><table id=t><tr><th>Task</th><th>Stage</th><th>Model</th><th>Duration</th><th>Cost</th><th>Status</th><th>Raw</th></tr></table><script>const d=PAYLOAD;s.textContent=JSON.stringify(d.summary,null,2);for(const r of d.rows){t.insertAdjacentHTML('beforeend',`<tr><td>${esc(r.task_id)}</td><td>${esc(r.stage)}</td><td>${esc(r.resolved_model)}</td><td>${r.duration_seconds||0}s</td><td>${r.cost_status} ${r.provider_cost_usd??r.rate_card_estimate_usd??'—'}</td><td>${r.success?'ok':'failed'}</td><td><a href="${esc(r.raw_output_path)}">output</a> <a href="${esc(r.error_path)}">errors</a></td></tr>`)}function esc(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</script>""".replace("PAYLOAD", payload)
    out.write_text(body, encoding="utf-8"); print(out)
    if not args.write_only: subprocess.run([sys.executable, "-m", "http.server", str(args.port)], cwd=out.parent)
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="mo"); p.add_argument("--root", default=".")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run-stage"); r.add_argument("--task-id", required=True); r.add_argument("--stage", required=True); r.add_argument("--provider", required=True); r.add_argument("--model"); r.add_argument("--run-id"); r.add_argument("--input"); r.add_argument("--command"); r.add_argument("--timeout", type=float, default=1800); r.add_argument("--cli-version"); r.add_argument("--resume", action="store_true"); r.set_defaults(fn=run_stage)
    u = sub.add_parser("usage"); u.add_argument("--by-model", action="store_true"); u.add_argument("--by-stage", action="store_true"); u.set_defaults(fn=lambda a: (print(json.dumps(summarize(read_ledger(Path(a.root)), "resolved_model" if a.by_model else "stage" if a.by_stage else None), indent=2)) or 0))
    q = sub.add_parser("report"); q.add_argument("task_id"); q.set_defaults(fn=lambda a: (print(json.dumps(summarize([x for x in read_ledger(Path(a.root)) if x.get("task_id") == a.task_id]), indent=2)) or 0))
    e = sub.add_parser("export"); e.add_argument("--format", choices=["json", "csv"], default="json"); e.set_defaults(fn=export_cmd)
    d = sub.add_parser("dashboard"); d.add_argument("--port", type=int, default=8765); d.add_argument("--write-only", action="store_true"); d.set_defaults(fn=dashboard)
    a = p.parse_args(argv); return a.fn(a)


if __name__ == "__main__": sys.exit(main())
