// Ejecutor de aos-verify (spec workflow-verify-reutilizable). Node >= 22, sin dependencias.
// Uso: node run-verify.mjs [--out resultado.json] [--config aos/verify.json]
// Mide `commands` de aos/verify.json y escribe el cuerpo de POST /v1/receipts. Fail-closed: lo que no se pudo medir
// sale en rojo (passed:false), nunca en verde. No imprime entorno ni token.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const sha256 = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const DEFAULT_TIMEOUT_MS = 600_000;
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Definicion a usar: la de la base si el evento es un PR que cambia el fichero (el PR no se mide a si mismo). */
export function resolveDefinition({ cwd, config, env }) {
  let raw = null, definitionChanged = false;
  if (env.GITHUB_EVENT_NAME === 'pull_request' || env.GITHUB_EVENT_NAME === 'pull_request_target') {
    let base = null;
    try { base = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.base?.sha ?? null; } catch { /* sin evento legible */ }
    if (!base) return { raw: null, definitionChanged: true, error: 'evento de PR sin base.sha: no se puede elegir la definicion' };
    const changed = git(['diff', '--quiet', base, 'HEAD', '--', config], cwd);
    if (changed.status === 1) {
      const shown = git(['show', `${base}:${config}`], cwd);
      // la base sin definicion (PR que la crea) no se mide con la del PR: rojo
      if (shown.status !== 0) return { raw: null, definitionChanged: true, error: 'la base no tiene definicion y el PR la cambia' };
      return { raw: shown.stdout, definitionChanged: true };
    }
    if (changed.status !== 0) return { raw: null, definitionChanged: false, error: `git diff fallo: ${changed.stderr.trim()}` };
  }
  try { raw = readFileSync(path.join(cwd, config), 'utf8'); } catch (e) { return { raw: null, definitionChanged, error: `no se pudo leer ${config}: ${e.code}` }; }
  return { raw, definitionChanged };
}

export function runVerify({ cwd = process.cwd(), config = 'aos/verify.json', env = process.env } = {}) {
  const def = resolveDefinition({ cwd, config, env });
  const sha = env.GITHUB_SHA || git(['rev-parse', 'HEAD'], cwd).stdout.trim();
  const red = (why) => ({ sha, verifyConfigDigest: sha256(def.raw ?? ''), plan: [], passed: false, notMeasured: [why],
    commands: [], definitionChanged: def.definitionChanged });
  if (def.raw === null) return red(def.error);
  let cfg;
  try { cfg = JSON.parse(def.raw); } catch { return red(`${config} no es JSON valido`); }
  const plan = Array.isArray(cfg.commands) ? cfg.commands : [];
  if (!plan.every((c) => typeof c === 'string' && c.trim())) return red('commands invalido');
  const timeouts = cfg.timeoutsMs && typeof cfg.timeoutsMs === 'object' ? cfg.timeoutsMs : {};
  const commands = plan.map((cmd) => {
    const key = Object.keys(timeouts).find((k) => cmd.includes(k));
    const timeout = Number.isFinite(timeouts[key]) ? timeouts[key] : DEFAULT_TIMEOUT_MS;
    const t0 = Date.now();
    const r = spawnSync(cmd, { cwd, shell: true, encoding: 'buffer', timeout, maxBuffer: 256 * 1024 * 1024, env });
    const out = Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)]);
    // timeout, señal o fallo de arranque: nunca 0
    const code = typeof r.status === 'number' ? r.status : (r.error?.code === 'ETIMEDOUT' ? 124 : 1);
    return { cmd, code, passed: code === 0, durationMs: Date.now() - t0, logDigest: sha256(out) };
  });
  return { sha, verifyConfigDigest: sha256(def.raw), plan, passed: commands.length > 0 && commands.every((c) => c.passed),
    notMeasured: commands.length === 0 ? ['commands vacio'] : [], commands, definitionChanged: def.definitionChanged };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const result = runVerify({ config: arg('--config', 'aos/verify.json') });
  const out = arg('--out', 'aos-verify-result.json');
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(result));
  for (const c of result.commands) console.log(`${c.passed ? 'PASS' : 'FAIL'} (${c.code}) ${c.cmd}`);
  console.log(`aos-verify: ${result.passed ? 'verde' : 'rojo'}${result.definitionChanged ? ' (definicion de la base)' : ''}`);
  process.exit(0); // el rojo se firma: el job decide su estado tras enviar el recibo
}
