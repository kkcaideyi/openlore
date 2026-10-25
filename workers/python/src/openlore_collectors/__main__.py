"""CLI entrypoint for openlore_collectors."""

import json
import os
import sys
import traceback
from openlore_collectors.protocol import (
    WorkerError,
    WorkerRequest,
    WorkerResponse,
    XUserRequest,
)
from openlore_collectors.web_feed.parser import parse_feed_content
from openlore_collectors.web_page.extractor import extract_article_content


def failed(job_id: str, code: str, message: str, retryable: bool) -> WorkerResponse:
    return WorkerResponse(
        protocol_version=1,
        job_id=job_id,
        status="failed",
        error=WorkerError(code=code, message=message, retryable=retryable),
    )


def handle_file(req: WorkerRequest) -> WorkerResponse:
    if not os.path.exists(req.input_path):
        return failed(req.job_id, "file_not_found", f"Input file not found: {req.input_path}", False)

    if req.operation == "parse_feed":
        with open(req.input_path, "rb") as f:
            content_bytes = f.read()
        data, issues = parse_feed_content(content_bytes, original_url=req.original_url)
    else:
        with open(req.input_path, "r", encoding="utf-8", errors="replace") as f:
            html_text = f.read()
        data, issues = extract_article_content(
            html_text,
            original_url=req.original_url,
            final_url=req.final_url,
        )
    return WorkerResponse(
        protocol_version=req.protocol_version,
        job_id=req.job_id,
        status="partial" if issues else "success",
        data=data,
        issues=issues,
    )


def main() -> None:
    job_id = "unknown"
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            resp = failed(job_id, "empty_input", "No input provided to collector worker", False)
        else:
            req_dict = json.loads(raw_input)
            job_id = str(req_dict.get("job_id") or job_id)
            operation = req_dict.get("operation")
            if operation in ("parse_feed", "extract_article"):
                resp = handle_file(WorkerRequest.from_dict(req_dict))
            elif operation == "collect_x_user":
                # Imported lazily: X collection is an optional extra.
                from openlore_collectors.x_user.collector import collect_user

                resp = collect_user(XUserRequest.from_dict(req_dict))
            else:
                resp = failed(job_id, "unsupported_operation", f"Operation '{operation}' is not supported", False)
    except Exception as e:
        sys.stderr.write(traceback.format_exc() + "\n")
        resp = failed(job_id, "internal_error", str(e)[:500], True)
    print(json.dumps(resp.to_dict()), file=sys.stdout)


if __name__ == "__main__":
    main()
