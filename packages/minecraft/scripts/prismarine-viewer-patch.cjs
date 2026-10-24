const FIRST_PERSON_CAMERA = `function updateFollowCamera (deltaSeconds) {
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
}`;

function normalizeIndexSource(source) {
  const viewerMarker = "const { Viewer, Entity } = require('../viewer')";
  const socketMarker = "const io = require('socket.io-client')";
  const viewerStart = source.indexOf(viewerMarker);
  const socketStart = source.indexOf(socketMarker, viewerStart);
  if (viewerStart < 0 || socketStart < 0) throw new Error('Could not normalize Prismarine Viewer imports');

  const imports = `const { Viewer, Entity } = require('../viewer')
const followCamera = require('./boson-follow-camera')
const FOLLOW_CAMERA_DISTANCE = 3.5
const CAMERA_COLLISION_RADIUS = 0.12
const CAMERA_COLLISION_CLEARANCE = 0.16
const FIRST_PERSON_DISTANCE = 0.02

`;
  source = source.slice(0, viewerStart) + imports + source.slice(socketStart);

  const stateStart = source.indexOf('let firstPositionUpdate = true');
  const rendererStart = source.indexOf('\nconst renderer =', stateStart);
  if (stateStart < 0 || rendererStart < 0) throw new Error('Could not normalize Prismarine Viewer camera state');
  const state = `let firstPositionUpdate = true
let targetPose
let currentPose
let currentCameraDistance = 0.02
let previousFrameTime = performance.now()
`;
  source = source.slice(0, stateStart) + state + source.slice(rendererStart);
  source = source.replaceAll('currentCameraDistance = FOLLOW_CAMERA_DISTANCE', 'currentCameraDistance = FIRST_PERSON_DISTANCE');

  const cameraStart = source.indexOf('function updateFollowCamera (');
  const animateStart = source.indexOf('\nfunction animate (', cameraStart);
  if (cameraStart >= 0 && animateStart >= 0 && !source.slice(cameraStart, animateStart).includes('const safeDistance = FIRST_PERSON_DISTANCE')) {
    source = source.slice(0, cameraStart) + FIRST_PERSON_CAMERA + source.slice(animateStart);
  }
  return source;
}

function normalizeVillagerTextureSource(source) {
  const overlayTexture = '"default": "textures/entity/villager/type/plains"'
  const baseTexture = '"default": "textures/entity/villager/villager"'
  if (source.includes(baseTexture)) return source
  if (source.includes(overlayTexture)) return source.replace(overlayTexture, baseTexture)

  const professionTextures = '"textures": {\n      "farmer": "textures/entity/villager/profession/farmer",'
  if (!source.includes(professionTextures)) {
    throw new Error('Could not find expected villager texture mapping')
  }
  return source.replace(
    professionTextures,
    `"textures": {\n      ${baseTexture},\n      "farmer": "textures/entity/villager/profession/farmer",`
  )
}

function normalizeEntityNameplateSource(source) {
  const startMarker = '      if (entity.username !== undefined) {'
  const endMarker = '        e.mesh.add(sprite)\n      }'
  const residentMarker = "      if (['Anna', 'James', 'Thomas'].includes(entity.username)) {"
  const completeMarker = `${residentMarker}\n        const canvas = createCanvas(1, 128)`
  if (source.includes(completeMarker)) return source

  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error('Could not find expected Prismarine Viewer entity nameplate code')
  const endOffset = end + endMarker.length
  const replacement = `${residentMarker}
        const canvas = createCanvas(1, 128)
        const ctx = canvas.getContext('2d')
        ctx.font = 'bold 84px Arial'
        const text = entity.username
        canvas.width = Math.ceil(ctx.measureText(text).width + 48)

        ctx.fillStyle = 'rgba(15, 23, 42, 0.82)'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.font = 'bold 84px Arial'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.lineJoin = 'round'
        ctx.lineWidth = 8
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.95)'
        ctx.strokeText(text, canvas.width / 2, canvas.height / 2)
        ctx.fillStyle = '#ffffff'
        ctx.fillText(text, canvas.width / 2, canvas.height / 2)

        const tex = new THREE.Texture(canvas)
        tex.needsUpdate = true
        const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
        const sprite = new THREE.Sprite(spriteMat)
        sprite.scale.set((canvas.width / canvas.height) * 0.3, 0.3, 1)
        sprite.position.y += entity.height + 0.35

        e.mesh.add(sprite)
      }`
  return source.slice(0, start) + replacement + source.slice(endOffset)
}

module.exports = { normalizeIndexSource, normalizeVillagerTextureSource, normalizeEntityNameplateSource }
