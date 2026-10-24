/**
 * Write `market.json` — a DSH plugin market index (format 1) for this bundle.
 *
 * Usage:
 *   1. Fill in AUTHOR / REPO below (once).
 *   2. Commit and push the release you want to publish.
 *   3. `node scripts/market.mjs`
 *   4. Commit the generated `market.json` and push it.
 *
 * Re-run steps 2–4 for every release: the index records the exact commit and
 * a Unix publish timestamp, so updates need a fresh entry.
 *
 * Format reference: @deepseek-ai/dsh-plugin-market-index (format 1 validator).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

/** Fill these in once, then never again. */
const AUTHOR = 'codeora-Kayson'
const REPO = 'https://github.com/codeora-Kayson/dsh-peak-meter'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

if (AUTHOR.includes('your-name') || REPO.includes('your-name')) {
  console.error('✗ 先把 scripts/market.mjs 顶部的 AUTHOR / REPO 改成真实值')
  process.exit(1)
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error('✗ 取不到提交 SHA，请先 git commit')
  process.exit(1)
}

const market = {
  format: 1,
  title: { zh: 'DS 插件小市场', en: 'DS plugins' },
  description: {
    zh: 'dsh-peak-meter 的插件市场索引',
    en: 'Plugin market index for dsh-peak-meter',
  },
  metadata: {
    categories: { cost: { title: { zh: '费用与计费', en: 'Cost & billing' } } },
    labels: { deepseek: { title: { zh: 'DeepSeek', en: 'DeepSeek' } } },
  },
  plugins: [
    {
      name: pkg.name,
      title: { zh: 'DS时段费用参考', en: 'DS Pricing & Cost' },
      description: {
        zh: pkg.description,
        en: 'DeepSeek peak/off-peak pricing, conversation and turn cost, and the account balance, shown under the composer.',
      },
      icon: './icon.svg',
      author: AUTHOR,
      homepage: REPO,
      repository: { url: REPO },
      metadata: {
        category: 'cost',
        keywords: ['deepseek', 'pricing', 'cost', 'balance', 'dsh'],
        labels: ['deepseek'],
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'git', url: REPO, commit },
        },
      ],
    },
  ],
}

writeFileSync(new URL('../market.json', import.meta.url), JSON.stringify(market, null, 2) + '\n')
console.log(`✓ market.json 已生成：${pkg.name}@${pkg.version} @ ${commit.slice(0, 7)}`)
