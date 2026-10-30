const WAITING = new Set(['QUEUED', 'PENDING', 'WAITING']);
const RUNNING = new Set(['IN_PROGRESS']);
// A superseded deployment turns INACTIVE; it still reached the environment.
const DONE = new Set(['SUCCESS', 'INACTIVE']);
export function runIdOf(url) {
    return /\/actions\/runs\/(\d+)/.exec(url ?? '')?.[1];
}
function recordState(record) {
    const state = record.latestStatus?.state ?? 'PENDING';
    if (WAITING.has(state))
        return 'queued';
    if (RUNNING.has(state))
        return 'running';
    return DONE.has(state) ? 'done' : 'fail';
}
function worst(states) {
    for (const one of ['fail', 'running', 'queued'])
        if (states.includes(one))
            return one;
    return 'done';
}
/** Groups records into attempts, oldest first. */
export function attempts(records) {
    const found = new Map();
    for (const record of records) {
        if (record.commitOid === undefined || record.createdAt === undefined)
            continue;
        const key = runIdOf(record.latestStatus?.logUrl) ?? record.commitOid;
        found.set(key, [...(found.get(key) ?? []), record]);
    }
    return [...found.entries()]
        .map(([key, group]) => {
        const created = group.map(one => one.createdAt ?? '').sort();
        const settled = group.map(one => one.latestStatus?.createdAt ?? one.createdAt ?? '').sort();
        const runId = runIdOf(group[0]?.latestStatus?.logUrl);
        return {
            key,
            commit: group[0]?.commitOid ?? '',
            runId,
            startedAt: created[0] ?? '',
            finishedAt: settled[settled.length - 1] ?? '',
            state: worst(group.map(recordState)),
            url: group[0]?.latestStatus?.logUrl ?? undefined,
        };
    })
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
/** Answers `null` for a cancelled run, which shipped nothing: a later run carries its commits. */
export function runState(run) {
    if (run.status !== 'completed')
        return run.status === 'in_progress' ? 'running' : 'queued';
    if (run.conclusion === 'success')
        return 'done';
    return run.conclusion === 'cancelled' || run.conclusion === 'skipped' ? null : 'fail';
}
/**
 * Where a merged PR stands against the deploys that started after its merge: done at the
 * first attempt that includes its merge commit and succeeded, else the attempt still going
 * or the one that failed. `null` when nothing deployed it yet and nothing is under way.
 */
export async function deployOf(merge, mergedAt, found, env, lookups) {
    let going = null;
    for (const attempt of found) {
        if (attempt.startedAt < mergedAt)
            continue;
        if (attempt.commit !== merge && !(await lookups.includes(merge, attempt.commit)))
            continue;
        let state = attempt.state;
        let at = attempt.finishedAt;
        if (attempt.runId !== undefined) {
            const run = await lookups.run(attempt.runId);
            if (run !== null) {
                state = runState(run);
                at = run.updatedAt;
            }
        }
        if (state === null)
            continue;
        if (state === 'done')
            return { state, env, at, url: attempt.url };
        // A running attempt says more than one that already failed.
        if (going === null || state !== 'fail')
            going = { state, env, url: attempt.url };
    }
    return going;
}
/** A day-and-time in the machine's own time zone, e.g. `30 Oct 2:31 pm`. */
export function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return iso;
    const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${day} ${time}`;
}
export function deployText(deploy) {
    if (deploy.state === 'done')
        return `deployed to ${deploy.env} ${formatTime(deploy.at ?? '')} ✓`;
    if (deploy.state === 'fail')
        return `deploy to ${deploy.env} ✗`;
    return `deploy to ${deploy.env} ● ${deploy.state === 'queued' ? 'queued' : 'running'}`;
}
