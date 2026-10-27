// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = Number(process.argv[2] || 47623)
const qaDirectory = path.dirname(fileURLToPath(import.meta.url))
const videoPath = path.resolve(qaDirectory, '../data/playlist/sample_video.mp4')
const counters = { control: 0, advertising: 0 }
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzOUAAAAASUVORK5CYII=', 'base64')

function page(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Velmren QA — ${title}</title>
<style>body{font:18px system-ui;background:#edf7f5;color:#123536;margin:40px;max-width:960px}nav{display:flex;gap:18px}a{color:#076c62}label{display:block;margin:16px 0}input,button{font:inherit;padding:10px}video{display:block;max-width:720px;width:100%;margin:20px 0}pre{white-space:pre-wrap}h1{font-size:30px}</style>
<nav><a href="/">Overview</a><a href="/login">Login</a><a href="/video">Video</a><a href="/ads">Ad blocking</a></nav><h1>${title}</h1>${body}</html>`
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://localhost:${port}`)
    response.setHeader('Cache-Control', 'no-store')
    if (url.pathname === '/sample.mp4') {
      const { size } = await stat(videoPath)
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '')
      const start = match ? Number(match[1]) : 0
      const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
      if (start >= size || start > end) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
        return
      }
      response.writeHead(match ? 206 : 200, {
        'Content-Type': 'video/mp4',
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
      })
      createReadStream(videoPath, { start, end }).pipe(response)
      return
    }
    if (url.pathname === '/control.png' || url.pathname === '/ad_banner.png') {
      counters[url.pathname === '/control.png' ? 'control' : 'advertising']++
      response.writeHead(200, { 'Content-Type': 'image/png' }).end(pixel)
      return
    }
    if (url.pathname === '/counts') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(counters))
      return
    }
    if (url.pathname === '/authenticate' && request.method === 'POST') {
      // Synthetic inputs only. Do not persist or log submitted credentials.
      request.resume()
      request.on('end', () => response.writeHead(303, { Location: '/signed-in' }).end())
      return
    }
    let html
    if (url.pathname === '/login' || url.pathname === '/login-delayed') {
      const form = '<form method="post" action="/authenticate"><label>Username <input id="username" name="username" autocomplete="username"></label><label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in with synthetic credentials</button></form>'
      html = page('Password filling', url.pathname === '/login' ? form : `<button id="reveal">Show login form</button><div id="host"></div><script>document.querySelector('#reveal').onclick=()=>{document.querySelector('#host').innerHTML=${JSON.stringify(form)}};</script>`)
    } else if (url.pathname === '/signed-in') {
      html = page('Synthetic sign-in completed', '<p>No account or submitted password was stored by this server.</p><a href="/login">Return to empty login form</a>')
    } else if (url.pathname === '/video') {
      html = page('Native picture in picture', '<video id="video" controls loop src="/sample.mp4"></video><button id="pip">Open native picture in picture</button><pre id="state"></pre><script>const video=document.querySelector("video"),state=document.querySelector("#state");document.querySelector("#pip").onclick=async()=>{try{await video.play();await video.requestPictureInPicture()}catch(e){state.textContent=e.name+": "+e.message}};for(const name of ["enterpictureinpicture","leavepictureinpicture","play","pause","seeked"]){video.addEventListener(name,()=>{state.textContent=JSON.stringify({event:name,paused:video.paused,currentTime:video.currentTime,pip:!!document.pictureInPictureElement},null,2)})}</script>')
    } else if (url.pathname === '/ads') {
      html = page('Controlled ad blocking', `<p>Use the isolated test profile with <code>--host-resolver-rules="MAP doubleclick.net 127.0.0.1"</code>. All image requests stay on this computer.</p><p>Control: <strong id="control">waiting</strong></p><p>Advertising: <strong id="ad">waiting</strong></p><script>for(const [id,src] of [['control','/control.png'],['ad','http://doubleclick.net:${port}/ad_banner.png']]){const img=new Image();img.onload=()=>document.getElementById(id).textContent='loaded';img.onerror=()=>document.getElementById(id).textContent='blocked or failed';img.src=src;document.body.append(img)}</script><p>Confirm the advertising image loads with Shields temporarily off, then is blocked with Shields on. Compare server counters at <a href="/counts">/counts</a>.</p>`)
    } else if (/^\/tab\/[123]$/.test(url.pathname)) {
      html = page(`Group tab ${url.pathname.at(-1)}`, '<p>Use this page to verify group name, color, membership and restart restoration.</p>')
    } else {
      html = page('Local browser checks', '<p>These pages use synthetic inputs and bundled test video.</p><p>Test tabs: <a href="/tab/1">One</a> · <a href="/tab/2">Two</a> · <a href="/tab/3">Three</a></p><p>The HTTP login checks save/import/selection behavior. Eligible HTTPS page-load filling and cross-origin restrictions are covered by Chromium password tests.</p>')
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html)
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain' }).end('Local fixture error')
  }
})

await writeFile(path.join(qaDirectory, 'synthetic-passwords.csv'), `name,url,username,password\nVelmren local test,http://localhost:${port}/login,velmren_test_user,Velmren_Test_Only_47623!\n`)
server.listen(port, '127.0.0.1', () => process.stdout.write(`Local fixture ready: http://localhost:${port}/\n`))
