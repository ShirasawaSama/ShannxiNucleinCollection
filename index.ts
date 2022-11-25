import Yoo from 'wechat-yoo'
import koaAdapter from 'wechat-yoo/adapters/koa.js'
import Koa from 'koa'
import fs, { promises } from 'fs'
// @ts-ignore
import bodyParser from 'koa-bodyparser'
import Router from '@koa/router'
import { ZipFile } from 'yazl'
import { exec } from 'child_process'

if (!fs.existsSync('data')) fs.mkdirSync('data')
if (!fs.existsSync('temp')) fs.mkdirSync('temp')
if (!fs.existsSync('users.json')) fs.writeFileSync('users.json', '[]')
if (!fs.existsSync('data.json')) fs.writeFileSync('data.json', '{}')
if (!fs.existsSync('.filename')) fs.writeFileSync('.filename', '应做{all}人-实做{actual}人.zip')
const users: string[] = JSON.parse(fs.readFileSync('users.json', 'utf-8'))

const userData: Record<string, { time: string, needCheck: boolean }> = JSON.parse(fs.readFileSync('data.json', 'utf-8'))

const route = new Router()

const getDate = (date: Date, char = '-') => date.getFullYear() + char + (date.getMonth() + 1).toString().padStart(2, '0') + char + date.getDate().toString().padStart(2, '0')
const tempMap: Record<string, { name?: string, file?: string, data?: { time: string, needCheck: boolean } }> = {}

const yoo = new Yoo('Token')
yoo.image(async (sender, { FromUserName, PicUrl }) => {
  const fileName = `temp/${Math.random().toString(36).slice(2)}.jpg`
  await fetch(PicUrl).then(it => it.arrayBuffer()).then(it => promises.writeFile(fileName, Buffer.from(it)))

  let moved = false
  try {
    const text = (await new Promise<string>((resolve, reject) => exec('Windows.Media.Ocr.Cli.exe ' + fileName, (err, stdout) => err ? reject(err) : resolve(stdout))))
      .replace(/ /g, '').replace(/\r/g, '').replace(/：/g, ':').replace(/彐/g, '-1')
    let name = /姓名(\n关系)?(\n证件号码)?(\n采样时间:)?(\n检测时间:)?(\n检测机构:)?\n(.+?)\n/.exec(text)?.[6] || '检测失败!'
    const date = new Date()
    const date2 = new Date(date.getTime() - 24 * 60 * 60 * 1000)
    const nuclein = text.includes('24小时内核酸采样已完成')
    let time = /2022[一-]\d\d[一-]\d\d\d\d:\d\d:\d\d/.exec(text)?.[0] || '检测失败!'
    if (time !== '检测失败!') time = time.replace(/一/g, '-').replace(/-(\d\d)(\d\d)/, '-$1 $2')
    if (nuclein && name !== '检测失败!') {
      let user = users.find(it => new RegExp('^' + name.replace(/\*/g, '.') + '$').test(it))
      if (!user && tempMap[FromUserName]?.name) user = tempMap[FromUserName].name
      const data = { time, needCheck: !nuclein || !(text.includes(getDate(date)) || text.includes(getDate(date)) || text.includes(getDate(date, '一')) || text.includes(getDate(date2, '一'))) }
      if (user) {
        name = user
        userData[user] = data
        await promises.writeFile('data.json', JSON.stringify(userData, null, 2))
        await promises.rename(fileName, `data/${name}.jpg`)
        moved = true
      } else {
        if (nuclein) {
          sender.text(`姓名: ${name}【检测失败-请发送你自己的名字】\n核酸检测: ${nuclein ? '已完成' : '未完成'}\n采样时间: ${time}`)
          tempMap[FromUserName] = { file: fileName, data }
          moved = true
          return
        } else name = '检测失败!'
      }
    }
    sender.text(`姓名: ${name}\n核酸检测: ${nuclein ? '已完成' : '未完成'}\n采样时间: ${time}`)
  } catch (e) {
    sender.text('识别异常!')
    console.error(e)
  } finally {
    if (!moved) await promises.unlink(fileName).catch(console.log)
  }
}).subscribe(sender => sender.text('直接发核酸检测截图给我就行啦!'))
  .text((sender, { Content, FromUserName }) => {
    if (!users.includes(Content)) {
      sender.text('你不在名单里!')
      return
    }
    const cache = tempMap[FromUserName]
    if (!cache) {
      sender.text('直接发核酸检测截图给我就行啦!')
      return
    }
    const { file, data } = cache
    cache.name = Content
    if (file && data) {
      delete cache.file
      delete cache.data
      sender.text(`姓名: ${Content}\n采样时间: ${data.time}`)
      userData[FromUserName] = data
      promises.writeFile('data.json', JSON.stringify(userData, null, 2)).catch(console.error)
      promises.rename(file, `data/${Content}.jpg`).catch(console.error)
    }
  })

const app = new Koa()

route.all('/yoo', bodyParser({ enableTypes: ['xml'] })).use(koaAdapter(yoo.callback()))
route.get('/screenshots.zip', async ctx => {
  const files = await fs.promises.readdir('data')
  const fileName = encodeURIComponent((await promises.readFile('.filename', 'utf-8'))
    .replace(/{all}/g, users.length.toString()).replace(/{actual}/g, files.length.toString()))

  ctx.set('Content-Type', 'application/zip')
  ctx.set('Content-Disposition', 'attachment; filename=' + fileName)
  ctx.status = 200

  const zip = new ZipFile()
  zip.outputStream.pipe(ctx.res)
  files.forEach(file => zip.addFile(`data/${file}`, file))
  zip.end()

  await new Promise(resolve => zip.outputStream.on('end', resolve))
})
route.get('/users', ctx => {
  ctx.body = `未做核酸检测的用户: ${users.filter(it => !userData[it]).join(', ')}
  
需要核查核酸时间的用户:\n${users.filter(it => userData[it]?.needCheck).map(it => `  ${it} (${userData[it].time})`).join('\n')}

做了核酸的用户:\n${users.filter(it => userData[it] && !userData[it].needCheck).map(it => `  ${it} (${userData[it].time})`).join('\n')}`
})
app.use(route.routes())

setInterval(async () => {
  if (new Date().getHours() <= 1) {
    await promises.writeFile('data.json', '{}')

    users.length = 0
    for (const key in userData) delete userData[key]
    for (const key in tempMap) {
      if (tempMap[key].data) {
        delete tempMap[key].data
        delete tempMap[key].file
      }
    }

    for (const key in promises.readdir('data')) {
      await promises.unlink(`data/${key}`)
    }
    for (const key in promises.readdir('temp')) {
      await promises.unlink(`temp/${key}`)
    }
  }
}, 1000 * 30 * 60)

app.listen(8123)
console.log('Started!')
