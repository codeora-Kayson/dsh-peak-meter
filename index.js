/**
 * Host half of the peak-meter bundle.
 *
 * The browser half reads the DeepSeek account through `ctx.remote.account` when
 * that namespace is mounted, and falls back to this loopback route when it is
 * not. The route is the only bridge: it answers with the account service's own
 * balance, so the plugin never stores or forwards a credential.
 */
export const inject = ['webServer', 'deepseekAccount']

const PATH = '/__dsh-peak-meter/balance'

const isLoopback = req => {
  const address = req && req.socket && req.socket.remoteAddress
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    (typeof address === 'string' && address.startsWith('127.'))
  )
}

const send = (res, status, body) => {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  } catch (error) {
    try {
      res.destroy()
    } catch (ignored) {
      /* nothing left to answer on */
    }
  }
}

const reasonOf = error =>
  String((error && (error.code || error.message)) || error || 'unknown').slice(0, 96)

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PATH,
        handler: async (req, res) => {
          let answered = false
          const answer = (status, body) => {
            if (answered) return
            answered = true
            send(res, status, body)
          }

          try {
            if (!isLoopback(req)) return answer(403, { state: 'failed', reason: 'forbidden' })

            // Cordis gates service access on `inject`; the row declares
            // `deepseekAccount`, so this read is served from the account's own
            // Host service rather than any credential.
            const account = ctx.deepseekAccount
            if (!account || typeof account.getBalance !== 'function') {
              return answer(200, { state: 'unavailable', reason: 'no-account-service' })
            }

            const locale = String(req.headers['x-dsh-locale'] || 'zh')
            const offset = Number(req.headers['x-dsh-offset'])
            const client = {
              version: '0.2.1-rc.2',
              locale,
              timezoneOffsetSeconds: Number.isFinite(offset) ? offset : 0,
            }

            let view = null
            try {
              view = await account.getState()
              if (!view || view.status === 'signed-out') {
                return answer(200, { state: 'signed-out' })
              }
            } catch (error) {
              // Not fatal: the balance read below still decides.
            }

            try {
              const balance = await account.getBalance(client)
              return answer(200, {
                state: 'ok',
                balance,
                links: view && view.links,
              })
            } catch (error) {
              return answer(200, { state: 'failed', reason: reasonOf(error) })
            }
          } catch (error) {
            return answer(200, { state: 'failed', reason: 'handler:' + reasonOf(error) })
          }
        },
      }),
    'peak-meter: balance route',
  )
}
