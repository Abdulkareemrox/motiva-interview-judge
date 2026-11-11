import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJudgeMessage, sealJudgeMessage } from "../lib/interview-judge-envelope.ts";

const RUNTIMES = {
  javascript: { image: "node:22-bookworm-slim", filename: "program.js", command: ["node", "/source/program.js"] },
  python: { image: "python:3.13-slim-bookworm", filename: "program.py", command: ["python3", "-B", "/source/program.py"] },
  cpp: { image: "gcc:14-bookworm", filename: "main.cpp", compile: ["g++", "-std=c++20", "-O2", "/source/main.cpp", "-o", "/compiled/program"], command: ["/compiled/program"] },
  java: { image: "eclipse-temurin:21-jdk-jammy", filename: "Main.java", compile: ["javac", "-proc:none", "-d", "/compiled", "/source/Main.java"], command: ["java", "-Xmx32m", "-Xss256k", "-XX:ActiveProcessorCount=1", "-XX:MaxMetaspaceSize=48m", "-XX:ReservedCodeCacheSize=16m", "-cp", "/compiled", "Main"] },
  react: { image: "node:22-bookworm-slim", filename: "App.jsx", compile: ["/opt/interview-react/node_modules/.bin/esbuild", "/source/App.jsx", "--bundle", "--platform=node", "--format=cjs", "--jsx=automatic", "--external:react", "--external:react-dom", "--outfile=/compiled/App.cjs"], command: ["node", "/opt/interview-react/runner.cjs"] },
};
const builtImages = new Map();

function command(executable, args, { timeout = 30000, input, maxBuffer = 65536 } = {}) {
  return new Promise((done) => {
    const child = execFile(executable, args, { timeout, maxBuffer, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      done({ ok: !error, stdout: stdout || "", stderr: stderr || "", exitCode: typeof error?.code === "number" ? error.code : 0, timedOut: Boolean(error?.killed), overflow: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function sandboxArguments(name, memoryMb, cpuSeconds, source, compiled, metrics, compile = false) {
  const cpu = compile ? 25 : Math.max(1, Math.ceil(cpuSeconds));
  const memory = compile ? 512 : Math.round(memoryMb);
  return [
    "run", "--interactive", "--name", name, "--network", "none", "--read-only", "--cpus", "1", "--memory", `${memory}m`, "--memory-swap", `${memory}m`,
    "--pids-limit", compile ? "128" : "64", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--security-opt", "no-new-privileges",
    "--ulimit", `cpu=${cpu}:${cpu + 1}`, "--ulimit", "core=0:0", "--ulimit", "nofile=256:256", "--ulimit", compile ? "fsize=16777216:16777216" : "fsize=65536:65536",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp", "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "NODE_PATH=/opt/interview-react/node_modules",
    "--mount", `type=bind,source=${source},target=/source,readonly`,
    "--mount", `type=bind,source=${compiled},target=/compiled${compile ? "" : ",readonly"}`,
    "--mount", `type=bind,source=${metrics},target=/metrics`,
  ];
}

async function buildRuntime(language, directory) {
  if (builtImages.has(language)) return builtImages.get(language);
  const image = `motiva-interview-${language}`;
  const file = join(directory, "Dockerfile");
  if (language === "react") await writeFile(join(directory, "runner.cjs"), `const React = require("react");\nconst { renderToStaticMarkup } = require("react-dom/server");\nasync function main() {\n  let input = "";\n  for await (const chunk of process.stdin) input += chunk;\n  const props = input.trim() ? JSON.parse(input) : {};\n  if (!props || typeof props !== "object" || Array.isArray(props)) throw new Error("React test input must be a JSON object of component props.");\n  const appModule = require("/compiled/App.cjs");\n  const Component = appModule.default || appModule.App;\n  if (typeof Component !== "function") throw new Error("Export a React component as the default export or as App.");\n  process.stdout.write(renderToStaticMarkup(React.createElement(Component, props)));\n}\nmain().catch((error) => { console.error(error.message); process.exitCode = 1; });\n`);
  const reactSetup = language === "react" ? "RUN npm install --prefix /opt/interview-react --no-save --ignore-scripts --no-audit --no-fund react@19.2.3 react-dom@19.2.3 esbuild@0.28.2\nCOPY runner.cjs /opt/interview-react/runner.cjs\n" : "";
  await writeFile(file, `FROM ${RUNTIMES[language].image}\nUSER root\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends time util-linux coreutils && rm -rf /var/lib/apt/lists/*\n${reactSetup}ENTRYPOINT []\nCMD ["/bin/true"]\n`);
  const built = await command("docker", ["build", "--pull", "--quiet", "-t", image, "-f", file, directory], { timeout: 240000, maxBuffer: 2000000 });
  if (!built.ok) throw new Error("The isolated language image could not be prepared.");
  builtImages.set(language, image);
  return image;
}

function executionStatus(result, oom, seconds, cpuSeconds) {
  if (result.overflow) return "Output limit exceeded";
  if (oom) return "Runtime error";
  if (result.timedOut || [124, 137, 152].includes(result.exitCode) || (seconds !== null && seconds > cpuSeconds)) return "Time limit exceeded";
  return result.ok ? "executed" : "Runtime error";
}

async function executeSandbox(payload, paths, image, test, compile = false) {
  const name = `interview-${randomUUID()}`;
  const metricsName = `${randomUUID()}.txt`;
  const wallSeconds = compile ? 35 : Math.min(20, payload.cpuSeconds * 3 + 2);
  const runtime = RUNTIMES[payload.language];
  const program = compile ? runtime.compile : runtime.command;
  const args = [...sandboxArguments(name, payload.memoryMb, payload.cpuSeconds, paths.source, paths.compiled, paths.metrics, compile), image,
    "/usr/bin/timeout", "--signal=KILL", String(wallSeconds), "/usr/bin/time", "--quiet", "--format", "%U %S %M %x", "--output", `/metrics/${metricsName}`,
    "/usr/bin/setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "--no-new-privs", ...program];
  try {
    const result = await command("docker", args, { timeout: (wallSeconds + 8) * 1000, input: compile ? undefined : test.input });
    const inspection = await command("docker", ["inspect", "--format", "{{.State.OOMKilled}}", name]);
    const oom = inspection.stdout.trim() === "true";
    const measured = await readFile(join(paths.metrics, metricsName), "utf8").catch(() => "");
    const values = measured.trim().split(/\s+/).map(Number);
    const seconds = values.length === 4 && Number.isFinite(values[0]) && Number.isFinite(values[1]) ? Math.round((values[0] + values[1]) * 1000) / 1000 : null;
    const memoryKb = values.length === 4 && Number.isFinite(values[2]) ? values[2] : null;
    const status = compile ? (result.ok ? "executed" : "Compilation error") : executionStatus(result, oom, seconds, payload.cpuSeconds);
    return { testId: test?.id || "compile", status, stdout: result.stdout, diagnostics: oom ? "Memory limit exceeded." : result.stderr.slice(0, 4000), seconds, memoryKb };
  } finally {
    await command("docker", ["rm", "--force", name]);
  }
}

function checkedPayload(raw) {
  if (!raw || typeof raw !== "object" || !Object.hasOwn(RUNTIMES, raw.language) || typeof raw.code !== "string" || raw.code.length > 40000) throw new Error("Invalid saved source.");
  if (!Number.isFinite(raw.cpuSeconds) || raw.cpuSeconds < .1 || raw.cpuSeconds > 5 || !Number.isFinite(raw.memoryMb) || raw.memoryMb < 32 || raw.memoryMb > 256) throw new Error("Invalid execution limits.");
  if (!Array.isArray(raw.tests) || !raw.tests.length || raw.tests.length > 20 || raw.tests.some((test) => typeof test.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(test.id) || typeof test.input !== "string" || test.input.length > 16000)) throw new Error("Invalid saved tests.");
  return raw;
}

export async function executePayload(raw, onResult = async () => {}) {
  if (process.platform !== "linux") throw new Error("The interview worker requires an isolated Linux runner.");
  const payload = checkedPayload(raw);
  const root = await mkdtemp(join(tmpdir(), "motiva-interview-"));
  const paths = { source: join(root, "source"), compiled: join(root, "compiled"), metrics: join(root, "metrics") };
  const results = [];
  try {
    const build = join(root, "build");
    await mkdir(build);
    const image = await buildRuntime(payload.language, build);
    await mkdir(paths.source, { mode: 0o755 });
    await mkdir(paths.compiled, { mode: 0o777 });
    await chmod(paths.compiled, 0o777);
    await mkdir(paths.metrics, { mode: 0o770 });
    const ownership = await command("sudo", ["-n", "chown", `0:${process.getgid()}`, paths.metrics]);
    const protection = await command("sudo", ["-n", "chmod", "2770", paths.metrics]);
    if (!ownership.ok || !protection.ok) throw new Error("Trusted resource-measurement storage could not be protected.");
    await writeFile(join(paths.source, RUNTIMES[payload.language].filename), payload.code, { mode: 0o444 });
    if (RUNTIMES[payload.language].compile) {
      const compiled = await executeSandbox(payload, paths, image, null, true);
      if (compiled.status !== "executed") {
        const failures = payload.tests.map((test) => ({ ...compiled, testId: test.id, status: "Compilation error", stdout: "", seconds: null, memoryKb: null }));
        await onResult(failures);
        return failures;
      }
    }
    for (const test of payload.tests) {
      const result = await executeSandbox(payload, paths, image, test);
      results.push(result);
      await onResult([result]);
    }
    return results;
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function workerRequest(job, action, content, key) {
  const envelope = sealJudgeMessage(content, key, action === "claim" ? "claim" : "result");
  const response = await fetch(`${job.callbackOrigin}/api/interview/worker`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(45000),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, envelope }),
  });
  if (!response.ok) throw new Error(`The application rejected the ${action} message (HTTP ${response.status}).`);
  return response.json();
}

async function runWorker() {
  const key = process.env.INTERVIEW_GITHUB_JUDGE_KEY || "";
  const job = openJudgeMessage(process.env.INTERVIEW_GITHUB_JOB || "", key, "job");
  if (!job || typeof job !== "object" || job.callbackOrigin !== process.env.INTERVIEW_APP_ORIGIN || !/^https:\/\//.test(job.callbackOrigin) || job.expiresAt < Date.now() || job.expiresAt > Date.now() + 1200000) throw new Error("Invalid or expired worker dispatch.");
  try {
    const claim = await workerRequest(job, "claim", job, key);
    const payload = openJudgeMessage(claim.envelope, key, "payload");
    if (payload?.job?.jobId !== job.jobId || payload?.job?.evaluationId !== job.evaluationId) throw new Error("The claimed source does not match this job.");
    await executePayload(payload, async (results) => { await workerRequest(job, "result", { job, results }, key); });
    console.log("Interview evaluation completed; private results delivered without artifacts.");
  } catch (error) {
    await workerRequest(job, "result", { job, error: "The isolated worker could not finish this evaluation. Saved source is retained; the owner may retry final grading." }, key).catch(() => {});
    throw error;
  }
}

function checkPlan() {
  const args = sandboxArguments("check", 128, 2, "/source", "/compiled", "/metrics");
  assert.ok(args.includes("--interactive"));
  assert.ok(args.includes("--read-only"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.ok(args.includes("no-new-privileges"));
  assert.equal(args.includes("--privileged"), false);
  assert.equal(args.some((value) => value.includes("docker.sock")), false);
  assert.throws(() => checkedPayload({ language: "javascript", code: "", cpuSeconds: 100, memoryMb: 128, tests: [] }));
  assert.throws(() => checkedPayload({ language: "__proto__", code: "", cpuSeconds: 2, memoryMb: 128, tests: [] }));
  console.log("Worker sandbox plan validated: no host network, no privileged mode, no socket mount, bounded resources.");
}

async function selfTest() {
  checkPlan();
  const fixtures = [
    { language: "javascript", code: 'const fs=require("fs");if(process.getuid()!==65534)process.exit(11);if(!/^CapEff:\\s+0+$/m.test(fs.readFileSync("/proc/self/status","utf8")))process.exit(12);try{fs.accessSync("/metrics",fs.constants.R_OK);process.exit(13)}catch{}if(fs.readFileSync("/proc/net/route","utf8").trim().split("\\n").length!==1)process.exit(14);try{fs.writeFileSync("/etc/interview-probe","blocked");process.exit(15)}catch{}console.log("isolated")', input: "", expected: "isolated", status: "executed" },
    { language: "javascript", code: "while(true) {}", input: "", expected: "", status: "Time limit exceeded" },
    { language: "javascript", code: 'process.stdout.write("x".repeat(200000))', input: "", expected: "", status: "Output limit exceeded" },
    { language: "python", code: 'import sys\nprint(sum(map(int, sys.stdin.read().split())))\n', input: "2 3\n", expected: "5", status: "executed" },
    { language: "cpp", code: '#include <iostream>\nint main(){long first,second;std::cin>>first>>second;std::cout<<first+second;}', input: "2 3\n", expected: "5", status: "executed" },
    { language: "java", code: 'import java.util.*;public class Main{public static void main(String[] args){Scanner input=new Scanner(System.in);System.out.println(input.nextInt()+input.nextInt());}}', input: "2 3\n", expected: "5", status: "executed" },
    { language: "react", code: 'export default function App({ name = "World" }) { return <main>Hello, {name}</main>; }', tests: [{ input: '{"name":"Ada"}', expected: "<main>Hello, Ada</main>" }, { input: '{"name":"<Ada>"}', expected: "<main>Hello, &lt;Ada&gt;</main>" }] },
  ];
  for (const fixture of fixtures) {
    const tests = fixture.tests || [{ input: fixture.input, expected: fixture.expected }];
    const results = await executePayload({ language: fixture.language, code: fixture.code, cpuSeconds: 1, memoryMb: 128, tests: tests.map((test) => ({ id: randomUUID(), input: test.input })) });
    for (const [index, result] of results.entries()) {
      assert.equal(result.status, fixture.status || "executed", `${fixture.language} sandbox self-test failed.`);
      if ((fixture.status || "executed") === "executed") { assert.equal(result.stdout.trim(), tests[index].expected); assert.ok(result.seconds !== null && result.memoryKb > 0); }
    }
    console.log(`Self-test passed: ${fixture.language} / ${fixture.status || "executed"}.`);
  }
}

try {
  if (process.argv.includes("--check-config")) checkPlan();
  else if (process.argv.includes("--self-test")) await selfTest();
  else if (process.env.GITHUB_ACTIONS === "true") await runWorker();
  else throw new Error("This worker must run in its approved isolated GitHub Actions repository.");
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : "Interview worker failed. No source, test input, output, or credential values were logged.");
  process.exitCode = 1;
}