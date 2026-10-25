"""Protocol definitions for Python worker."""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class WorkerRequest:
    protocol_version: int
    job_id: str
    operation: str
    input_path: str
    original_url: Optional[str] = None
    final_url: Optional[str] = None
    response_meta: Dict[str, Any] = field(default_factory=dict)
    options: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WorkerRequest":
        return cls(
            protocol_version=data["protocol_version"],
            job_id=data["job_id"],
            operation=data["operation"],
            input_path=data["input_path"],
            original_url=data.get("original_url"),
            final_url=data.get("final_url"),
            response_meta=data.get("response_meta", {}),
            options=data.get("options", {}),
        )


@dataclass
class XUserRequest:
    protocol_version: int
    job_id: str
    handle: str
    accounts_db: str
    state: Dict[str, Any]
    max_pages: int
    deadline_seconds: float

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "XUserRequest":
        return cls(
            protocol_version=data["protocol_version"],
            job_id=data["job_id"],
            handle=data["handle"],
            accounts_db=data["accounts_db"],
            state=data.get("state") or {},
            max_pages=int(data["budget"]["max_pages"]),
            deadline_seconds=float(data["budget"]["deadline_seconds"]),
        )


@dataclass
class WorkerError:
    code: str
    message: str
    retryable: bool
    retry_after_seconds: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "retry_after_seconds": self.retry_after_seconds,
        }


@dataclass
class WorkerResponse:
    protocol_version: int
    job_id: str
    status: str  # "success" | "partial" | "failed"
    data: Optional[Any] = None
    issues: List[str] = field(default_factory=list)
    error: Optional[WorkerError] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "job_id": self.job_id,
            "status": self.status,
            "data": self.data,
            "issues": self.issues,
            "error": self.error.to_dict() if self.error else None,
        }
