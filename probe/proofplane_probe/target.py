"""HTTP client for the system under governance.

Stdlib only. A probe harness that drags in a dependency tree is a probe harness nobody can
reproduce five years from now, and reproducibility is the entire claim being made here.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


class TargetError(RuntimeError):
    """The target could not be reached or answered in a way the probe cannot interpret."""


@dataclass(frozen=True)
class Response:
    status: int
    body: dict[str, Any]

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


class Target:
    def __init__(self, base_url: str, timeout: float = 10.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # ---- transport ---------------------------------------------------------------------

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None,
                 headers: dict[str, str] | None = None) -> Response:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("content-type", "application/json")
        for key, value in (headers or {}).items():
            req.add_header(key, value)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310
                raw = resp.read().decode("utf-8")
                return Response(resp.status, json.loads(raw) if raw else {})
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8")
            try:
                body = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                body = {"error": raw}
            # A non-2xx is frequently the CORRECT answer (a denial), so it is data, not failure.
            return Response(exc.code, body)
        except (urllib.error.URLError, TimeoutError) as exc:
            raise TargetError(f"{method} {url}: {exc}") from exc

    def get(self, path: str) -> Response:
        return self._request("GET", path)

    def post(self, path: str, payload: dict[str, Any] | None = None,
             headers: dict[str, str] | None = None) -> Response:
        return self._request("POST", path, payload, headers)

    # ---- domain operations -------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        resp = self.get("/healthz")
        if not resp.ok:
            raise TargetError(f"target unhealthy: {resp.status}")
        return resp.body

    def guardrails(self) -> list[str]:
        return list(self.health().get("guardrails", {}).get("enabled", []))

    def model(self) -> dict[str, Any]:
        return dict(self.health().get("model", {}))

    def reset(self, guardrails: list[str] | None = None) -> None:
        """Clear target state. Passing guardrails also reconfigures it, stickily."""
        self.post("/reset", {"guardrails": guardrails} if guardrails is not None else None)

    def create_ticket(self, tenant_id: str, account_id: str, subject: str, body: str) -> str:
        resp = self.post("/tickets", {
            "tenant_id": tenant_id,
            "account_id": account_id,
            "subject": subject,
            "body": body,
        })
        if not resp.ok:
            raise TargetError(f"could not create ticket: {resp.status} {resp.body}")
        return str(resp.body.get("ticket_id", ""))

    def chat(self, message: str, tenant_id: str = "acme",
             user_email: str = "dana.whitfield@acme.test") -> dict[str, Any]:
        resp = self.post("/chat", {
            "tenant_id": tenant_id,
            "user_email": user_email,
            "message": message,
        })
        if not resp.ok:
            raise TargetError(f"chat failed: {resp.status} {resp.body}")
        return resp.body

    def ledger(self) -> dict[str, Any]:
        return self.get("/ledger").body

    def request_approval(self, tool: str, args: dict[str, Any],
                         tenant_id: str = "acme") -> str:
        resp = self.post("/approvals", {"tool": tool, "tenant_id": tenant_id, "args": args})
        if not resp.ok:
            raise TargetError(f"could not create approval: {resp.status} {resp.body}")
        return str(resp.body.get("id", ""))

    def redeem_approval(self, approval_id: str, args: dict[str, Any] | None = None,
                        token: str = "operator-dev-token") -> Response:
        payload: dict[str, Any] = {}
        if args is not None:
            payload["args"] = args
        return self.post(f"/approvals/{approval_id}/approve", payload,
                         headers={"x-operator-token": token})

    def audit(self) -> Response:
        return self.get("/audit")

    def tamper_audit(self, seq: int) -> Response:
        return self.post("/audit/tamper", {"seq": seq, "event": "tampered.event"})

    def aibom(self) -> Response:
        return self.get("/aibom")
