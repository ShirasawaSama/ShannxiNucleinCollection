import { createWorker } from 'tesseract.js'
import Yoo from 'wechat-yoo'
import koaAdapter from 'wechat-yoo/adapters/koa.js'
import Koa from 'koa'
import fs, { promises } from 'fs'
// @ts-ignore
import bodyParser from 'koa-bodyparser'
import Router from '@koa/router'
import { ZipFile } from 'yazl'

if (!fs.existsSync('data')) fs.mkdirSync('data')
if (!fs.existsSync('users.json')) fs.writeFileSync('users.json', '[]')
if (!fs.existsSync('data.json')) fs.writeFileSync('data.json', '{}')
if (!fs.existsSync('config.json')) fs.writeFileSync('config.json', JSON.stringify({ token: Math.random().toString(36).slice(2), id: '', secret: '', autoFetchAccessToken: true }, null, 2))
const users: string[] = JSON.parse(fs.readFileSync('users.json', 'utf-8'))

const userData: Record<string, { nuclein: boolean, time: string }> = JSON.parse(fs.readFileSync('data.json', 'utf-8'))

const worker = createWorker({ })
const route = new Router()

const getDate = (date: Date) => date.getFullYear() + '-' + (date.getMonth() + 1).toString().padStart(2, '0') + '-' + date.getDate().toString().padStart(2, '0')

const yoo = new Yoo(JSON.parse(fs.readFileSync('config.json', 'utf-8')))
yoo.image((sender, { FromUserName, PicUrl }) => {
  sender.text('正在识别中...')
  worker.recognize(PicUrl).then(({ data: { text } }) => {
    const data = text.replace(/ /g, '').replace(/\n/g, '')
    let name = /姓名(.+?)\n/.exec(text.replace(/ /g, ''))?.[1] || '检测失败!'
    const date = new Date()
    const nuclein = data.includes('24小时内核酸采样已完成') && (data.includes(getDate(date)) || data.includes(getDate(new Date(date.getTime() - 24 * 60 * 60 * 1000))))
    const time = /采样时间:(.+?)检测/.exec(data)?.[1] || '检测失败!'
    if (name !== '检测失败!') {
      const user = users.find(it => new RegExp('^' + name.replace(/\*/g, '.') + '$').test(it))
      if (user) {
        name = user
        userData[user] = { nuclein, time }
        promises.writeFile('data.json', JSON.stringify(userData, null, 2)).catch(console.error)
        fetch(PicUrl).then(it => it.arrayBuffer()).then(it => promises.writeFile(`data/${name}.jpg`, Buffer.from(it)), console.error)
      } else name = '检测失败!'
    }

    if (name === '检测失败!') console.log(data)

    fetch('https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=' + yoo.accessToken, {
      method: 'POST',
      body: JSON.stringify({
        touser: FromUserName,
        template_id: 'QrYDPvUv4y28hYRM3qMk_qWiH7J44f9oLAgHqmqW1as',
        data: {
          name: { value: name },
          nuclein: { value: nuclein ? '有' : '无' },
          time: { value: time }
        }
      })
    }).then(it => it.json()).then(it => { if (it.errcode) throw new Error(it.errmsg) }, console.error)
  })
})

const app = new Koa()

route.all('/yoo', bodyParser({ enableTypes: ['xml'] })).use(koaAdapter(yoo.callback()))
route.get('/screenshots.zip', async ctx => {
  ctx.set('Content-Type', 'application/zip')
  ctx.set('Content-Disposition', 'attachment; filename="screenshots.zip"')
  ctx.status = 200

  const zip = new ZipFile()
  zip.outputStream.pipe(ctx.res)
  await fs.promises.readdir('data').then(files => files.forEach(file => zip.addFile(`data/${file}`, file)))
  zip.end()

  await new Promise(resolve => zip.outputStream.on('end', resolve))
})
route.get('/users', ctx => {
  ctx.body = `未做核酸检测的用户: ${users.filter(it => !userData[it]?.nuclein).join(', ')}
  
做了核酸的用户:\n${users.filter(it => userData[it]?.nuclein).map(it => `  ${it} (${userData[it].time})`).join('\n')}`
})
app.use(route.routes())

;(async () => {
  await worker.load()
  await worker.loadLanguage('chi_sim')
  await worker.initialize('chi_sim')

  app.listen(8123)
  console.log('Started!')
})()

setInterval(async () => {
  if (new Date().getHours() === 0) {
    await promises.writeFile('data.json', '{}')
    await promises.writeFile('users.json', '[]')

    users.length = 0
    for (const key in userData) delete userData[key]

    for (const key in promises.readdir('data')) {
      await promises.unlink(`data/${key}`)
    }
  }
}, 1000 * 60 * 60)
