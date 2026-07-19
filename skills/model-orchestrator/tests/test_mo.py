import csv
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "mo.py"


def run(root, *args):
    return subprocess.run([sys.executable, str(SCRIPT), "--root", str(root), *args], text=True, capture_output=True)


class OrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        (self.root / ".orchestrator").mkdir()
        (self.root / ".orchestrator" / "config.toml").write_text('''[pricing.codex-medium]\ninput_per_1m = 1.0\noutput_per_1m = 2.0\n''')

    def tearDown(self): self.tmp.cleanup()

    def test_json_exact_and_redaction(self):
        p = 'echo \'{"request_id":"r1","usage":{"input_tokens":10,"output_tokens":5},"cost_usd":0.42,"api_key=secret":"x"}\''
        r = run(self.root, "run-stage", "--task-id", "TASK-123", "--stage", "implement", "--provider", "claude", "--model", "codex-medium", "--command", p)
        self.assertEqual(r.returncode, 0); row = json.loads(r.stdout); self.assertEqual(row["cost_status"], "exact")
        raw = (self.root / row["raw_output_path"]).read_text(); self.assertNotIn("secret", raw)

    def test_jsonl_estimate_missing_cost_and_report(self):
        p = 'printf \'{"usage":{"input_tokens":100,"output_tokens":50}}\\n{"usage":{"input_tokens":20,"output_tokens":10}}\\n\''
        r = run(self.root, "run-stage", "--task-id", "TASK-123", "--stage", "review", "--provider", "codex", "--model", "codex-medium", "--command", p)
        row = json.loads(r.stdout); self.assertEqual(row["total_tokens"], 180); self.assertEqual(row["cost_status"], "estimated")
        report = json.loads(run(self.root, "report", "TASK-123").stdout); self.assertEqual(report["total_tokens"], 180)

    def test_duplicate_stream_events_are_counted_once(self):
        line = '{"event_id":"e1","usage":{"input_tokens":4,"output_tokens":6}}'
        p = "printf '%s\\n%s\\n' '" + line + "' '" + line + "'"
        r = run(self.root, "run-stage", "--task-id", "T", "--stage", "stream", "--provider", "claude", "--command", p)
        self.assertEqual(json.loads(r.stdout)["total_tokens"], 10)

    def test_missing_usage_malformed_and_failed_timeout(self):
        r = run(self.root, "run-stage", "--task-id", "T", "--stage", "x", "--provider", "cursor", "--command", "echo not-json")
        self.assertEqual(json.loads(r.stdout)["cost_status"], "unavailable")
        r = run(self.root, "run-stage", "--task-id", "T", "--stage", "bad", "--provider", "x", "--command", "exit 7")
        self.assertEqual(r.returncode, 7); self.assertFalse(json.loads(r.stdout)["success"])
        r = run(self.root, "run-stage", "--task-id", "T", "--stage", "slow", "--provider", "x", "--command", "sleep 1", "--timeout", "0.01")
        self.assertEqual(r.returncode, 124)

    def test_resume_and_exports_dashboard(self):
        p = 'echo \'{"usage":{"input_tokens":1,"output_tokens":1},"cost":0.1}\''
        args = ("run-stage", "--task-id", "T", "--stage", "one", "--provider", "x", "--model", "m", "--run-id", "run1", "--command", p)
        self.assertEqual(run(self.root, *args).returncode, 0); self.assertEqual(run(self.root, *args, "--resume").returncode, 0)
        self.assertEqual(run(self.root, "export", "--format", "csv").returncode, 0)
        d = run(self.root, "dashboard", "--write-only"); self.assertEqual(d.returncode, 0); self.assertIn("dashboard.html", d.stdout)
        self.assertIn('"stages": 1', (self.root / ".orchestrator" / "dashboard.html").read_text())


if __name__ == "__main__": unittest.main()
