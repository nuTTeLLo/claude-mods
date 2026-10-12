import { expect, test } from 'claude-code/testing'

test('writes a bar for insert and a block otherwise', async ($, on) => {
  const written: string[] = []
  on('process.run', (_$, e) => {
    const isFind = e.argv.length === 3
    if (!isFind) written.push(`${e.argv[4]} ${e.argv[5]}`)

    return {
      value: { exitCode: 0, stdout: isFind ? '/dev/ttys999\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  on('ui.render', ($$, e) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>hint</Text>
  })

  for (const hint of ['-- INSERT --', '? for shortcuts', '-- INSERT -- ? for shortcuts']) {
    const ui = await $.ui.mount({ plugin: 'vim-cursor', surface: 'terminal', component: 'PromptHint', props: { hint, isDraft: false, isWorking: false } })
    await ui.unmount()
  }

  expect(written).toEqual(['6 /dev/ttys999', '2 /dev/ttys999', '6 /dev/ttys999'])
})
