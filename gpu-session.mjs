// @codedna
// description: Durable timed RunPod GPU session with shared expiry reconciliation.
//
//
//
//
//
//
//
//
//
//
// 
//
// 
//
// 
//
// 
//
// 
//
// exports: createGpuSession
// used_by: sonora-studio/gpu-session-watchdog.mjs
//                   sonora-studio/server.mjs
// rules:   Record expiry before starting paid compute; never cancel generation; confirm stop remotely.
// agent:   unknown
import fs from 'node:fs';
import path from 'node:path';

export function createGpuSession({
  dataDir,
  endpointId,
  getEndpointId = () => endpointId,
  remote,
  now = Date.now,
  onChange = () => {},
}) {
  const file = path.join(dataDir, 'gpu-session.json'),
    lock = file + '.lock';
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { phase: 'off' });
  const save = state => {
    fs.writeFileSync(file + '.tmp', JSON.stringify(state));
    fs.renameSync(file + '.tmp', file);
    onChange();
  };
  const status = () => {
    const s = read();
    return {
      phase: s.phase,
      expiresAt: s.expiresAt || null,
      error: s.error || null,
      active: s.phase !== 'off',
      durationMinutes: 30,
    };
  };
  async function locked(task) {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 120000) fs.unlinkSync(lock);
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') throw new Error('GPU session is updating. Try again in a few seconds.');
      throw e;
    }
    try {
      return await task();
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
  async function stopUnlocked() {
    const s = read();
    if (s.phase === 'off') return status();
    if (s.endpointId !== getEndpointId()) throw new Error('The saved RunPod session belongs to a different endpoint.');
    save({ ...s, phase: 'stopping', expiresAt: Math.min(s.expiresAt, now()), error: null });
    try {
      await remote.sessionSettings(0);
      save({ phase: 'off' });
    } catch {
      save({
        ...read(),
        error: 'Shutdown was not confirmed. Sonora will retry automatically; check RunPod if the issue persists.',
      });
      throw new Error(status().error);
    }
    return status();
  }
  return {
    status,
    start: () =>
      locked(async () => {
        const activeEndpointId = getEndpointId();
        if (!activeEndpointId) throw new Error('Configure a RunPod endpoint first.');
        if (read().phase !== 'off')
          throw new Error('End the current session before starting another.');
        const before = await remote.sessionSettings();
        if (before.workersMin !== 0 || before.workersMax !== 1)
          throw new Error('The RunPod configuration must request a minimum of 0 and a maximum of 1 GPU.');
        save({ phase: 'starting', endpointId: activeEndpointId, expiresAt: now() + 30 * 60000 });
        try {
          await remote.sessionSettings(1);
          save({ ...read(), phase: 'active' });
        } catch {
          save({ ...read(), phase: 'stopping', expiresAt: now() });
          throw new Error(
            'Startup was not confirmed. Automatic shutdown has been scheduled.'
          );
        }
        return status();
      }),
    stop: () => locked(stopUnlocked),
    reconcile: async () => {
      const s = read();
      if (s.phase !== 'off' && (s.phase === 'stopping' || s.expiresAt <= now())) return locked(stopUnlocked);
      return status();
    },
  };
}
