import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const run = promisify(execFile), repository = path.resolve(import.meta.dirname, "..");

test("manual entry launches one selected live session and the close command targets that session", { skip: process.platform !== "win32" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "same-page-entry-"));
  t.after(async () => {
    const statePath = path.join(root, "tmp/manual-session.json");
    const state = await fs.readFile(statePath, "utf8").then(JSON.parse).catch(() => null);
    if (state?.sessionId) {
      await fs.writeFile(path.join(root, "tmp/close-manual-session.signal"), JSON.stringify({ command: "close", sessionId: state.sessionId }));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const folder of ["scripts", "src", "config", "tmp"]) await fs.mkdir(path.join(root, folder));
  for (const name of ["Open-ManualLogin", "Close-ManualLogin", "ManualVerification", "ManualAbandonment", "CheckinContract.generated", "ResultContract"]) {
    await fs.copyFile(path.join(repository, "scripts", `${name}.ps1`), path.join(root, "scripts", `${name}.ps1`));
  }
  await fs.writeFile(path.join(root, "scripts/Resolve-Runtime.ps1"),
    (await fs.readFile(path.join(repository, "scripts/Resolve-Runtime.ps1"), "utf8")) + String.raw`
function Resolve-CheckinNode($Config) { return $Config.nodeExecutable }
function Get-CheckinAutomationBrowserProcesses { return @() }
`);
  await fs.writeFile(path.join(root, "scripts/Open-PlainLoginChrome.ps1"), "throw 'Unrelated native entry must not be launched'");
  await fs.writeFile(path.join(root, "config/config.json"), JSON.stringify({ nodeExecutable: process.execPath,
    runMutexName: `Local\\SamePageFixture-${randomUUID()}`, samePageManualCheckinRules: { "https://verify.example": {} } }));
  await fs.writeFile(path.join(root, "src/live-checkin-session.mjs"), String.raw`
import fs from 'node:fs'; import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), args=process.argv.slice(2);
if(args.includes('--plan')){console.log(JSON.stringify({origin:'https://verify.example'}));}
else{
  const id=args[args.indexOf('--session-id')+1];
  const statePath=path.join(root,'tmp/manual-session.json');
  fs.writeFileSync(statePath,JSON.stringify({schemaVersion:3,mode:'live_checkin',sessionId:id,pid:process.pid,
    processStartedAt:new Date(Date.now()-process.uptime()*1000).toISOString(),stage:'waiting_for_verification',
    windowRetained:true,targets:[{origin:'https://verify.example'}]}));
  const timer=setInterval(()=>{
    let signal;try{signal=JSON.parse(fs.readFileSync(path.join(root,'tmp/close-manual-session.signal')));}catch{return;}
    if(signal.command==='close'&&signal.sessionId===id){
      fs.writeFileSync(path.join(root,'tmp/closed.json'),JSON.stringify({closed:true,matchingSession:true}));
      fs.unlinkSync(statePath);clearInterval(timer);process.exit(0);
    }
  },25);
  setTimeout(()=>process.exit(1),20000).unref();
}
`);
  await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts/Open-ManualLogin.ps1"), "-Origins", "https://verify.example"],
    { cwd: root, timeout: 15_000, windowsHide: true });
  const state = JSON.parse(await fs.readFile(path.join(root, "tmp/manual-session.json"), "utf8"));
  assert.equal(state.mode, "live_checkin"); assert.equal(state.windowRetained, true);
  assert.deepEqual(state.targets, [{ origin: "https://verify.example" }]);
  await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts/Close-ManualLogin.ps1")],
    { cwd: root, timeout: 15_000, windowsHide: true });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "tmp/closed.json"), "utf8")), { closed: true, matchingSession: true });
  await assert.rejects(fs.access(path.join(root, "tmp/manual-session.json")), { code: "ENOENT" });
});
