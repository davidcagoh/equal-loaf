const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { normalizeIndexSource, normalizeVillagerTextureSource, normalizeEntityNameplateSource } = require('./prismarine-viewer-patch.cjs')

const viewerRoot = path.join(__dirname, '..', 'node_modules', 'prismarine-viewer')
const webpackPath = process.env.BOSON_WEBPACK_BIN || path.join(__dirname, '..', 'node_modules', '.bin', 'webpack')
if (!fs.existsSync(webpackPath)) {
  console.error('Cannot verify or build the Boson viewer patch: webpack is unavailable. Install packages/minecraft devDependencies before launching the demo.')
  process.exit(1)
}

const viewerPackage = require(path.join(viewerRoot, 'package.json'))

if (viewerPackage.version !== '1.33.0') {
  throw new Error(`Expected prismarine-viewer@1.33.0, found ${viewerPackage.version}`)
}

const PATCH_REVISION = 'boson-first-person-controls-complete-resident-nameplates-v7'
const markerPath = path.join(viewerRoot, '.boson-patch-state.json')
const patchHash = crypto.createHash('sha256')
  .update(PATCH_REVISION)
  .update(fs.readFileSync(__filename))
  .update(fs.readFileSync(path.join(__dirname, 'prismarine-viewer-patch.cjs')))
  .update(fs.readFileSync(path.join(__dirname, 'follow-camera.cjs')))
  .digest('hex')
const patchAssetsComplete = () => {
  try {
    const viewerSource = fs.readFileSync(path.join(viewerRoot, 'lib', 'index.js'), 'utf8')
    const mineflayerSource = fs.readFileSync(path.join(viewerRoot, 'lib', 'mineflayer.js'), 'utf8')
    const page = fs.readFileSync(path.join(viewerRoot, 'public', 'index.html'), 'utf8')
    const bundle = fs.readFileSync(path.join(viewerRoot, 'public', 'index.js'), 'utf8')
    const worker = fs.readFileSync(path.join(viewerRoot, 'public', 'worker.js'), 'utf8')
    const worldView = fs.readFileSync(path.join(viewerRoot, 'viewer', 'lib', 'worldView.js'), 'utf8')
    const entities = fs.readFileSync(path.join(viewerRoot, 'viewer', 'lib', 'entities.js'), 'utf8')
    const entityModels = fs.readFileSync(path.join(viewerRoot, 'viewer', 'lib', 'entity', 'entities.json'), 'utf8')
    return viewerSource.includes('const safeDistance = FIRST_PERSON_DISTANCE')
      && viewerSource.includes('localLookPose')
      && !viewerSource.includes('const currentCameraDistance = 3.5')
      && mineflayerSource.includes("socket.on('boson:controls'")
      && mineflayerSource.includes("socket.on('boson:control-release'")
      && page.includes('Click the world to play · WASD move · mouse look')
      && bundle.includes('bosonLookPose')
      && worldView.includes("['Anna', 'James', 'Thomas'].includes(e.username) ? 'villager' : e.name")
      && entities.includes("if (['Anna', 'James', 'Thomas'].includes(entity.username))")
      && entities.includes('sprite.scale.set((canvas.width / canvas.height) * 0.3, 0.3, 1)')
      && entities.includes("ctx.fillStyle = '#ffffff'")
      && entityModels.includes('"default": "textures/entity/villager/villager"')
      && !/if\([\w$]+\.position\.y<0\)continue;?/.test(worker)
  } catch {
    return false
  }
}
const patchIsCurrent = () => {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    return marker.revision === PATCH_REVISION && marker.hash === patchHash && patchAssetsComplete()
  } catch {
    return false
  }
}
if (patchIsCurrent()) process.exit(0)

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

function replaceAnyExpected (relativePath, alternatives, after, expectedCount = 1) {
  const filePath = path.join(viewerRoot, relativePath)
  const source = fs.readFileSync(filePath, 'utf8')
  const afterCount = source.split(after).length - 1
  if (afterCount >= expectedCount) return
  let remaining = expectedCount - afterCount
  let updated = source
  for (const before of alternatives) {
    updated = updated.replaceAll(before, () => {
      if (remaining === 0) return before
      remaining -= 1
      return after
    })
  }
  if (remaining !== 0) throw new Error(`Found too few matching Prismarine Viewer sections in ${relativePath}`)
  fs.writeFileSync(filePath, updated)
}

function replaceSection (relativePath, startMarker, endMarker, replacement, completionMarker) {
  const filePath = path.join(viewerRoot, relativePath)
  const source = fs.readFileSync(filePath, 'utf8')
  if (source.includes(completionMarker)) return
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`Could not find expected Prismarine Viewer section in ${relativePath}`)
  fs.writeFileSync(filePath, source.slice(0, start) + replacement + source.slice(end))
}

{
  const filePath = path.join(viewerRoot, 'lib', 'index.js')
  const source = fs.readFileSync(filePath, 'utf8')
  const normalized = normalizeIndexSource(source)
  if (normalized !== source) fs.writeFileSync(filePath, normalized)
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
  'public/index.html',
  '      canvas {\n',
  '      .camera-help {\n        position: fixed;\n        z-index: 1;\n        left: 16px;\n        bottom: 16px;\n        padding: 10px 14px;\n        border: 1px solid rgba(255,255,255,.18);\n        border-radius: 8px;\n        background: rgba(15,23,42,.82);\n        color: #f8fafc;\n        font: 13px/1.4 system-ui, sans-serif;\n        pointer-events: none;\n      }\n\n      canvas {\n'
)
replaceExpected(
  'lib/mineflayer.js',
  "    bot.on('move', botPosition)\n    worldView.listenToBot(bot)",
  "    bot.on('move', botPosition)\n    botPosition()\n    worldView.listenToBot(bot)"
)
replaceExpected(
  'lib/mineflayer.js',
  "    socket.on('disconnect', () => {\n      bot.removeListener('move', botPosition)",
  "    socket.on('boson:controls', (packet) => bot.viewer.emit('boson:controls', socket.id, packet))\n    socket.on('boson:control-release', () => bot.viewer.emit('boson:control-release', socket.id))\n    socket.on('disconnect', () => {\n      bot.viewer.emit('boson:control-disconnect', socket.id)\n      bot.removeListener('move', botPosition)"
)
replaceAnyExpected(
  'viewer/lib/worldView.js',
  [
    'name: e.name, pos: e.position, width: e.width, height: e.height, username: e.username',
    "name: ['MiraGardener', 'TobinCart', 'PipBaker'].includes(e.username) ? 'villager' : e.name, pos: e.position, width: e.width, height: e.height, username: e.username",
    'name: bosonEntityModelName(e.name, e.username), pos: e.position, width: e.width, height: e.height, username: e.username',
  ],
  "name: ['Anna', 'James', 'Thomas'].includes(e.username) ? 'villager' : e.name, pos: e.position, width: e.width, height: e.height, username: e.username",
  2,
)
{
  const entityPath = path.join(viewerRoot, 'viewer', 'lib', 'entities.js')
  const source = fs.readFileSync(entityPath, 'utf8')
  const normalized = normalizeEntityNameplateSource(source)
  if (normalized !== source) fs.writeFileSync(entityPath, normalized)
}
{
  const entityModelsPath = path.join(viewerRoot, 'viewer', 'lib', 'entity', 'entities.json')
  const source = fs.readFileSync(entityModelsPath, 'utf8')
  const normalized = normalizeVillagerTextureSource(source)
  if (normalized !== source) fs.writeFileSync(entityModelsPath, normalized)
}
replaceAnyExpected(
  'lib/index.js',
  [
    'let firstPositionUpdate = true\n',
    'let firstPositionUpdate = true\nlet targetPose\nlet currentPose\nlet currentCameraDistance = 3.5\nlet previousFrameTime = performance.now()\n'
  ],
  'let firstPositionUpdate = true\nlet targetPose\nlet currentPose\nlet currentCameraDistance = 0.02\nlet previousFrameTime = performance.now()\n'
)
replaceExpected(
  'lib/index.js',
  "global.THREE = require('three')\nconst TWEEN = require('@tweenjs/tween.js')\nrequire('three/examples/js/controls/OrbitControls')",
  "const THREE = global.THREE = require('three')\nconst { OrbitControls } = require('three/examples/jsm/controls/OrbitControls')\nconst TWEEN = require('@tweenjs/tween.js')"
)
replaceExpected(
  'lib/index.js',
  'new THREE.OrbitControls(viewer.camera, renderer.domElement)',
  'new OrbitControls(viewer.camera, renderer.domElement)'
)
replaceExpected(
  'lib/index.js',
  "const { Viewer, Entity } = require('../viewer')\n",
  "const { Viewer, Entity } = require('../viewer')\nconst followCamera = require('./boson-follow-camera')\nconst FOLLOW_CAMERA_DISTANCE = 3.5\nconst CAMERA_COLLISION_RADIUS = 0.12\nconst CAMERA_COLLISION_CLEARANCE = 0.16\nconst FIRST_PERSON_DISTANCE = 0.02\n"
)
replaceExpected(
  'lib/index.js',
  'const CAMERA_COLLISION_CLEARANCE = 0.16\n',
  'const CAMERA_COLLISION_CLEARANCE = 0.16\nconst FIRST_PERSON_DISTANCE = 0.02\n'
)
replaceSection(
  'lib/index.js',
  'function animate () {',
  '\n}\nanimate()',
  `const cameraRaycaster = new THREE.Raycaster()
const cameraPivot = new THREE.Vector3()
const cameraForward = new THREE.Vector3()
const cameraBackward = new THREE.Vector3()
const cameraRight = new THREE.Vector3()
const cameraUp = new THREE.Vector3()
const cameraRayOrigin = new THREE.Vector3()
const cameraPosition = new THREE.Vector3()
const cameraBoomEnd = new THREE.Vector3()
const cameraOffsets = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1]
]

function updateFollowCamera (deltaSeconds) {
  if (!targetPose) return

  if (!currentPose) {
    currentPose = { ...targetPose, position: { ...targetPose.position } }
  } else {
    const amount = 1 - Math.exp(-14 * deltaSeconds)
    currentPose = {
      position: {
        x: currentPose.position.x + (targetPose.position.x - currentPose.position.x) * amount,
        y: currentPose.position.y + (targetPose.position.y - currentPose.position.y) * amount,
        z: currentPose.position.z + (targetPose.position.z - currentPose.position.z) * amount
      },
      yaw: followCamera.interpolateAngle(currentPose.yaw, targetPose.yaw, amount),
      pitch: followCamera.interpolateAngle(currentPose.pitch, targetPose.pitch, amount),
      eyeHeight: targetPose.eyeHeight
    }
  }

  const { position, eyeHeight } = currentPose
  const localLookPose = window.bosonLookPose
  const yaw = Number.isFinite(localLookPose?.yaw) ? localLookPose.yaw : currentPose.yaw
  const pitch = Number.isFinite(localLookPose?.pitch) ? localLookPose.pitch : currentPose.pitch
  cameraPivot.set(position.x, position.y + eyeHeight, position.z)
  const direction = followCamera.viewDirection(yaw, pitch)
  cameraForward.set(direction.x, direction.y, direction.z).normalize()
  cameraBackward.copy(cameraForward).negate()
  cameraRight.set(Math.cos(yaw), 0, -Math.sin(yaw))
  cameraUp.crossVectors(cameraRight, cameraForward).normalize()

  const hitDistances = []
  cameraRaycaster.far = FOLLOW_CAMERA_DISTANCE
  cameraBoomEnd.copy(cameraPivot).addScaledVector(cameraBackward, FOLLOW_CAMERA_DISTANCE)
  const meshes = followCamera.selectNearbySectionMeshes(
    viewer.world.sectionMeshs,
    cameraPivot,
    cameraBoomEnd,
    CAMERA_COLLISION_RADIUS
  )
  for (const [horizontal, vertical] of cameraOffsets) {
    cameraRayOrigin.copy(cameraPivot)
      .addScaledVector(cameraRight, horizontal * CAMERA_COLLISION_RADIUS)
      .addScaledVector(cameraUp, vertical * CAMERA_COLLISION_RADIUS)
    cameraRaycaster.set(cameraRayOrigin, cameraBackward)
    const hit = cameraRaycaster.intersectObjects(meshes, false)[0]
    if (hit) hitDistances.push(hit.distance)
  }

  const safeDistance = FIRST_PERSON_DISTANCE
  currentCameraDistance = safeDistance

  const posePosition = followCamera.cameraPosition(position, yaw, pitch, eyeHeight, currentCameraDistance)
  cameraPosition.set(posePosition.x, posePosition.y, posePosition.z)
  viewer.camera.position.copy(cameraPosition)
  viewer.camera.lookAt(cameraPivot)
}

function animate (frameTime) {
  window.requestAnimationFrame(animate)
  const deltaSeconds = Math.min(Math.max((frameTime - previousFrameTime) / 1000, 0), 0.1)
  previousFrameTime = frameTime
  if (controls) controls.update()
  updateFollowCamera(deltaSeconds)
  viewer.update()
  renderer.render(viewer.scene, viewer.camera)`,
  'const safeDistance = FIRST_PERSON_DISTANCE'
)
replaceExpected(
  'lib/index.js',
  '  const { position, yaw, pitch, eyeHeight } = currentPose\n  cameraPivot.set(position.x, position.y + eyeHeight, position.z)',
  '  const { position, eyeHeight } = currentPose\n  const localLookPose = window.bosonLookPose\n  const yaw = Number.isFinite(localLookPose?.yaw) ? localLookPose.yaw : currentPose.yaw\n  const pitch = Number.isFinite(localLookPose?.pitch) ? localLookPose.pitch : currentPose.pitch\n  cameraPivot.set(position.x, position.y + eyeHeight, position.z)'
)
replaceExpected(
  'lib/index.js',
  '        botMesh = new Entity(\'1.16.4\', \'player\', viewer.scene).mesh\n        viewer.scene.add(botMesh)',
  '        botMesh = new Entity(\'1.16.4\', \'player\', viewer.scene).mesh\n        botMesh.visible = false\n        viewer.scene.add(botMesh)'
)
replaceExpected(
  'lib/index.js',
  '  const safeDistance = followCamera.resolveBoomDistance(\n    FOLLOW_CAMERA_DISTANCE,\n    hitDistances,\n    CAMERA_COLLISION_CLEARANCE\n  )\n  if (safeDistance < currentCameraDistance) {\n    currentCameraDistance = safeDistance\n  } else {\n    const zoomOutAmount = 1 - Math.exp(-4.5 * deltaSeconds)\n    currentCameraDistance += (safeDistance - currentCameraDistance) * zoomOutAmount\n  }',
  '  const safeDistance = FIRST_PERSON_DISTANCE\n  currentCameraDistance = safeDistance'
)
replaceExpected(
  'lib/index.js',
  'const cameraPosition = new THREE.Vector3()\n',
  'const cameraPosition = new THREE.Vector3()\nconst cameraBoomEnd = new THREE.Vector3()\n'
)
replaceExpected(
  'lib/index.js',
  '  const hitDistances = []\n  const meshes = Object.values(viewer.world.sectionMeshs)\n  cameraRaycaster.far = FOLLOW_CAMERA_DISTANCE\n',
  `  const hitDistances = []
  cameraRaycaster.far = FOLLOW_CAMERA_DISTANCE
  cameraBoomEnd.copy(cameraPivot).addScaledVector(cameraBackward, FOLLOW_CAMERA_DISTANCE)
  const meshes = followCamera.selectNearbySectionMeshes(
    viewer.world.sectionMeshs,
    cameraPivot,
    cameraBoomEnd,
    CAMERA_COLLISION_RADIUS
  )
`
)
replaceAnyExpected(
  'lib/index.js',
  [
    '  firstPositionUpdate = true\n  viewer.listen(socket)',
    '  firstPositionUpdate = true\n  targetPose = undefined\n  currentPose = undefined\n  currentCameraDistance = FOLLOW_CAMERA_DISTANCE\n  viewer.listen(socket)'
  ],
  '  firstPositionUpdate = true\n  targetPose = undefined\n  currentPose = undefined\n  currentCameraDistance = 0.02\n  viewer.listen(socket)'
)
replaceSection(
  'lib/index.js',
  '  let botMesh\n  socket.on(\'position\', ({ pos, addMesh, yaw, pitch }) => {',
  '\n  })\n})',
  `  let botMesh
  socket.on('position', ({ pos, addMesh, yaw, pitch, eyeHeight }) => {
    if (!pos || ![pos.x, pos.y, pos.z, yaw, pitch].every(Number.isFinite)) return

    targetPose = {
      position: { x: pos.x, y: pos.y, z: pos.z },
      yaw,
      pitch,
      eyeHeight: Number.isFinite(eyeHeight) && eyeHeight > 0 ? eyeHeight : 1.6
    }

    if (firstPositionUpdate) {
      if (controls) {
        controls.dispose()
        controls = null
      }
      currentPose = { ...targetPose, position: { ...targetPose.position } }
      currentCameraDistance = 0.02
      firstPositionUpdate = false
    }

    if (addMesh) {
      if (!botMesh) {
        botMesh = new Entity('1.16.4', 'player', viewer.scene).mesh
        botMesh.visible = false
        viewer.scene.add(botMesh)
      }
      new TWEEN.Tween(botMesh.position).to({ x: pos.x, y: pos.y, z: pos.z }, 50).start()

      const da = (yaw - botMesh.rotation.y) % (Math.PI * 2)
      const dy = 2 * da % (Math.PI * 2) - da
      new TWEEN.Tween(botMesh.rotation).to({ y: botMesh.rotation.y + dy }, 50).start()
    }
  `,
  "  socket.on('position', ({ pos, addMesh, yaw, pitch, eyeHeight }) => {"
)
replaceExpected(
  'lib/mineflayer.js',
  `      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true }
      if (firstPerson) {
        packet.pitch = bot.entity.pitch
      }`,
  '      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, pitch: bot.entity.pitch, eyeHeight: bot.entity.eyeHeight, addMesh: true }'
)
replaceAnyExpected(
  'public/index.html',
  [
    '  <body>\n    <div class="camera-help" role="status">Drag to look · scroll to zoom · right-drag to pan</div>\n',
    '  <body>\n    <div class="camera-help" role="status">Third-person view follows the explorer’s look direction</div>\n'
  ],
  '  <body>\n    <div class="camera-help" role="status">Click the world to play · WASD move · mouse look · Esc releases controls</div>\n'
)

fs.copyFileSync(path.join(__dirname, 'follow-camera.cjs'), path.join(viewerRoot, 'lib', 'boson-follow-camera.js'))
const build = spawnSync(webpackPath, ['--config', 'webpack.config.js'], { cwd: viewerRoot, stdio: 'inherit' })
if (build.error || build.status !== 0) throw build.error || new Error(`Prismarine Viewer webpack exited with ${build.status}`)

{
  const filePath = path.join(viewerRoot, 'public', 'worker.js')
  const source = fs.readFileSync(filePath, 'utf8')
  const updated = source.replace(/if\([\w$]+\.position\.y<0\)continue;?/g, '')
  if (updated !== source) fs.writeFileSync(filePath, updated)
}

if (!patchAssetsComplete()) throw new Error('Prismarine Viewer patch verification failed after build')
fs.writeFileSync(markerPath, `${JSON.stringify({ revision: PATCH_REVISION, hash: patchHash })}\n`, { mode: 0o600 })
