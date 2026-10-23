const fs = require('node:fs')
const path = require('node:path')

const viewerRoot = path.join(__dirname, '..', 'node_modules', 'prismarine-viewer')
const viewerPackage = require(path.join(viewerRoot, 'package.json'))

if (viewerPackage.version !== '1.33.0') {
  throw new Error(`Expected prismarine-viewer@1.33.0, found ${viewerPackage.version}`)
}

function replaceExpected (relativePath, before, after, expectedCount = 1) {
  const filePath = path.join(viewerRoot, relativePath)
  const source = fs.readFileSync(filePath, 'utf8')
  const beforeCount = source.split(before).length - 1
  const afterCount = after ? source.split(after).length - 1 : (beforeCount === 0 ? expectedCount : 0)
  if (afterCount >= expectedCount) return
  if (beforeCount + afterCount < expectedCount) {
    throw new Error(`Could not find expected Prismarine Viewer code in ${relativePath}`)
  }
  let remaining = expectedCount - afterCount
  const updated = source.replaceAll(before, () => {
    if (remaining === 0) return before
    remaining -= 1
    return after
  })
  fs.writeFileSync(filePath, updated)
}

function replaceAnyExpected (relativePath, alternatives, after) {
  const filePath = path.join(viewerRoot, relativePath)
  const source = fs.readFileSync(filePath, 'utf8')
  if (source.includes(after)) return
  const before = alternatives.find((candidate) => source.includes(candidate))
  if (!before) throw new Error(`Could not find expected Prismarine Viewer code in ${relativePath}`)
  fs.writeFileSync(filePath, source.replace(before, after))
}

replaceExpected(
  'viewer/lib/worldrenderer.js',
  '    this.loadedChunks = {}\n',
  '    this.loadedChunks = {}\n    this.chunkHeightRanges = {}\n'
)
replaceExpected(
  'viewer/lib/worldrenderer.js',
  '    this.sectionMeshs = {}\n    for (const worker of this.workers) {',
  '    this.sectionMeshs = {}\n    this.chunkHeightRanges = {}\n    for (const worker of this.workers) {'
)
replaceExpected(
  'viewer/lib/worldView.js',
  "        const chunk = column.toJson()\n        this.emitter.emit('loadChunk', { x: pos.x, z: pos.z, chunk })",
  "        const chunkData = JSON.parse(column.toJson())\n        chunkData.minY = column.minY\n        chunkData.worldHeight = column.worldHeight\n        const chunk = JSON.stringify(chunkData)\n        this.emitter.emit('loadChunk', { x: pos.x, z: pos.z, chunk })"
)
replaceExpected(
  'viewer/lib/world.js',
  '    const chunk = this.Chunk.fromJson(json)\n    this.columns[columnKey(x, z)] = chunk',
  '    const chunkData = JSON.parse(json)\n    const chunk = this.Chunk.fromJson(json)\n    if (Number.isInteger(chunkData.minY)) chunk.minY = chunkData.minY\n    if (Number.isInteger(chunkData.worldHeight)) chunk.worldHeight = chunkData.worldHeight\n    this.columns[columnKey(x, z)] = chunk'
)
replaceExpected(
  'viewer/lib/viewer.js',
  'this.world = new WorldRenderer(this.scene)',
  'this.world = new WorldRenderer(this.scene, 1)'
)
replaceAnyExpected(
  'viewer/lib/worldrenderer.js',
  [
    '    this.loadedChunks[`${x},${z}`] = true\n    const minY = chunk.minY ?? 0\n    const worldHeight = chunk.worldHeight ?? 256\n    this.chunkHeightRanges[`${x},${z}`] = { minY, worldHeight }\n    for (const worker of this.workers) {',
    '    this.loadedChunks[`${x},${z}`] = true\n    for (const worker of this.workers) {'
  ],
  "    this.loadedChunks[`${x},${z}`] = true\n    const chunkData = typeof chunk === 'string' ? JSON.parse(chunk) : chunk\n    const minY = chunkData.minY ?? 0\n    const worldHeight = chunkData.worldHeight ?? 256\n    this.chunkHeightRanges[`${x},${z}`] = { minY, worldHeight }\n    for (const worker of this.workers) {"
)
replaceExpected(
  'viewer/lib/worldrenderer.js',
  '    for (let y = 0; y < 256; y += 16) {',
  '    for (let y = minY; y < minY + worldHeight; y += 16) {',
  2
)
replaceExpected(
  'viewer/lib/worldrenderer.js',
  '    delete this.loadedChunks[`${x},${z}`]\n    for (const worker of this.workers) {',
  '    delete this.loadedChunks[`${x},${z}`]\n    const { minY = 0, worldHeight = 256 } = this.chunkHeightRanges[`${x},${z}`] || {}\n    delete this.chunkHeightRanges[`${x},${z}`]\n    for (const worker of this.workers) {'
)
replaceExpected(
  'viewer/lib/worker.js',
  'chunk.sections[Math.floor(y / 16)]',
  'chunk.sections[Math.floor((y - (chunk.minY ?? 0)) / 16)]',
  2
)
replaceExpected(
  'viewer/lib/models.js',
  '      if (neighbor.position.y < 0) continue\n',
  ''
)
replaceExpected(
  'viewer/lib/models.js',
  '    if (neighbor.position.y < 0) continue\n',
  ''
)
replaceExpected(
  'lib/index.js',
  'if (pos.y > 0 && firstPositionUpdate) {',
  'if (firstPositionUpdate) {'
)
replaceExpected(
  'lib/mineflayer.js',
  "    bot.on('move', botPosition)\n    worldView.listenToBot(bot)",
  "    bot.on('move', botPosition)\n    botPosition()\n    worldView.listenToBot(bot)"
)

replaceExpected(
  'public/index.js',
  'this.scene=t,this.loadedChunks={},this.sectionsOutstanding=',
  'this.scene=t,this.loadedChunks={},this.chunkHeightRanges={},this.sectionsOutstanding='
)
replaceExpected(
  'public/index.js',
  'this.sectionMeshs={};for(const t of this.workers)t.postMessage({type:"reset"})',
  'this.sectionMeshs={},this.chunkHeightRanges={};for(const t of this.workers)t.postMessage({type:"reset"})'
)
replaceAnyExpected(
  'public/index.js',
  [
    'addColumn(t,e,i){this.loadedChunks[`${t},${e}`]=!0;let o=i.minY??0,a=i.worldHeight??256;this.chunkHeightRanges[`${t},${e}`]={minY:o,worldHeight:a};for(const n of this.workers)n.postMessage({type:"chunk",x:t,z:e,chunk:i});for(let i=o;i<o+a;i+=16){',
    'addColumn(t,e,i){this.loadedChunks[`${t},${e}`]=!0;for(const n of this.workers)n.postMessage({type:"chunk",x:t,z:e,chunk:i});for(let i=0;i<256;i+=16){'
  ],
  'addColumn(t,e,i){this.loadedChunks[`${t},${e}`]=!0;let r=JSON.parse(i),o=r.minY??0,a=r.worldHeight??256;this.chunkHeightRanges[`${t},${e}`]={minY:o,worldHeight:a};for(const n of this.workers)n.postMessage({type:"chunk",x:t,z:e,chunk:i});for(let i=o;i<o+a;i+=16){'
)
replaceExpected(
  'public/index.js',
  'removeColumn(t,e){delete this.loadedChunks[`${t},${e}`];for(const i of this.workers)i.postMessage({type:"unloadChunk",x:t,z:e});for(let i=0;i<256;i+=16){',
  'removeColumn(t,e){delete this.loadedChunks[`${t},${e}`];let{minY:o=0,worldHeight:a=256}=this.chunkHeightRanges[`${t},${e}`]||{};delete this.chunkHeightRanges[`${t},${e}`];for(const i of this.workers)i.postMessage({type:"unloadChunk",x:t,z:e});for(let i=o;i<o+a;i+=16){'
)
replaceExpected(
  'public/index.js',
  'if(t.y>0&&s&&',
  'if(s&&'
)
replaceExpected(
  'public/index.js',
  'this.world=new a(this.scene)',
  'this.world=new a(this.scene,1)'
)

replaceExpected(
  'public/worker.js',
  'i.sections[Math.floor(a/16)]',
  'i.sections[Math.floor((a-(i.minY??0))/16)]'
)
replaceExpected(
  'public/worker.js',
  'l.sections[Math.floor(n/16)]',
  'l.sections[Math.floor((n-(l.minY??0))/16)]'
)
replaceExpected(
  'public/worker.js',
  'addColumn(e,t,n){const a=this.Chunk.fromJson(n);return this.columns[i(e,t)]=a,a}',
  'addColumn(e,t,n){const r=JSON.parse(n),a=this.Chunk.fromJson(n);return Number.isInteger(r.minY)&&(a.minY=r.minY),Number.isInteger(r.worldHeight)&&(a.worldHeight=r.worldHeight),this.columns[i(e,t)]=a,a}'
)
{
  const filePath = path.join(viewerRoot, 'public/worker.js')
  const source = fs.readFileSync(filePath, 'utf8')
  const updated = source.replace(/if\([\w$]+\.position\.y<0\)continue;?/g, '')
  if (updated !== source) fs.writeFileSync(filePath, updated)
}
