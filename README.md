# Isolated Interview Judge

Generic encrypted code-evaluation worker for Motiva Hub. This repository does not contain the private application, candidate source, questions, test inputs, expected outputs, provider credentials, or candidate records.

## Execution

- Manual workflow dispatch only; job pointers are authenticated AES-256-GCM envelopes.
- Standard `ubuntu-latest` GitHub-hosted runners only. The workflow refuses private repositories.
- Source and test input are claimed from the private application using an authenticated encrypted request. Expected outputs remain in the application.
- JavaScript, Python, C++, and Java run inside separate Docker sandboxes with networking disabled, a read-only filesystem, unprivileged user code, process/CPU/memory/output limits, and no Docker socket or host environment mounts.
- Trusted parent processes measure CPU time and peak resident memory. Candidate processes cannot alter the measurement directory.
- Encrypted results return directly to the application. No candidate artifacts, workflow caches, or result files are uploaded. Logs omit private source, test input/output, and secrets.

## Configuration

Set the repository secret `INTERVIEW_GITHUB_JUDGE_KEY` to the application's dedicated worker key. Set the repository variable `INTERVIEW_APP_ORIGIN` to the application's canonical HTTPS origin. Never use an application session-signing key as the worker key.

The application must verify that this repository remains public before dispatching. Only trusted maintainers may modify this workflow or its worker source.

## Verification

Run the workflow with `self_test=true` to test all supported languages, disabled networking, unprivileged execution, protected measurements, read-only filesystem behavior, time limits, and output limits. These fixtures contain no candidate data and require no application credentials.

## Limits

This is queued CI-based evaluation, not a low-latency execution service or a secure lockdown browser. GitHub fair-use, availability, queue, API, and concurrency limits apply. Use only standard public-repository runners and retain the no-artifact/no-cache configuration to avoid adding paid runner or storage usage. Do not select larger runners or move this worker to a private repository. Review GitHub's applicable terms for your workload.