import type { EngineInterface, Register } from 'claude-code'

// DECSCUSR shapes: the terminal's own cursor, steady.
const BLOCK = '2'
const BAR = '6'
const DEFAULT = '0'

// Hooks run without a controlling terminal, so walk up to the first ancestor that has one.
const FIND_TTY = `p=$PPID
while [ -n "$p" ] && [ "$p" != 1 ]; do
  t=$(ps -o tty= -p "$p" | tr -d ' ')
  case "$t" in
    ''|'??') p=$(ps -o ppid= -p "$p" | tr -d ' ') ;;
    *) echo "/dev/$t"; exit 0 ;;
  esac
done
exit 1`

let tty: string | undefined
let shape: string | undefined

// The hint line under the prompt carries vim's `-- INSERT --` marker.
export function shapeFor(hint: string): string {
  return /insert/i.test(hint) ? BAR : BLOCK
}

async function findTty($: EngineInterface): Promise<string | undefined> {
  if (tty !== undefined) return tty
  try {
    const ran = await $.process.run(['sh', '-c', FIND_TTY])
    const found = ran.stdout.trim()
    if (ran.exitCode === 0 && found.startsWith('/dev/')) tty = found
  } catch {
    // No terminal to write to (a desktop or headless session): the mod does nothing.
  }

  return tty
}

async function setShape($: EngineInterface, wanted: string): Promise<void> {
  if (wanted === shape) return
  const device = await findTty($)
  if (device === undefined) return
  shape = wanted
  await $.process.run(['sh', '-c', 'printf "\\033[%s q" "$1" > "$2"', 'sh', wanted, device])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Vim mode starts a prompt in insert.
    void setShape($, BAR)

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (e.surface === 'terminal') {
      void setShape($, shapeFor(e.props.hint))
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await setShape($, DEFAULT)

    return next(e)
  })
}
