import type Database from "better-sqlite3";

export function recoverInterruptedRuns(database: Database.Database, now: string): void {
  const chatRuns = database.prepare(`SELECT j.id,a.conversation_id,a.user_message_id
    FROM job_runs j JOIN conversation_turn_attempts a ON a.job_run_id=j.id
    WHERE j.job_type='paper-chat' AND j.state='running'`).all() as Array<{
      id: string;
      conversation_id: string;
      user_message_id: string;
    }>;
  database.transaction(() => {
    for (const run of chatRuns) {
      const changed = database.prepare(`UPDATE job_runs SET state='interrupted',progress=1,
        error_json='{"code":"process-interrupted"}',completed_at=?,heartbeat_at=?
        WHERE id=? AND state='running'`).run(now, now, run.id).changes;
      if (changed) database.prepare(`INSERT INTO durable_events(scope,event_type,data_json,created_at)
        VALUES (?,'message-interrupted',?,?)`).run(run.conversation_id,
          JSON.stringify({ jobRunId: run.id, userMessageId: run.user_message_id }), now);
    }
    database.prepare(`UPDATE job_runs SET state='interrupted',progress=1,completed_at=?,heartbeat_at=?
      WHERE state='running'`).run(now, now);
  })();
}
