import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeBridgeSession(sessionId, socketPath, baseDir) {
  const sessionsDir = path.join(baseDir, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  
  const sessionData = {
    session_id: sessionId,
    messagingSock: socketPath,
    status: 'RUNNING',
    created_at: new Date().toISOString()
  };
  
  const filePath = path.join(sessionsDir, `${sessionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(sessionData, null, 2), 'utf8');
}
