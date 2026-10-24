const MIN_BOOM_DISTANCE = 0.02

function viewDirection (yaw, pitch) {
  const pitchCosine = Math.cos(pitch)
  return {
    x: -Math.sin(yaw) * pitchCosine,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * pitchCosine
  }
}

function cameraPosition (position, yaw, pitch, eyeHeight, distance) {
  const direction = viewDirection(yaw, pitch)
  const pivot = { x: position.x, y: position.y + eyeHeight, z: position.z }
  return {
    x: pivot.x - direction.x * distance,
    y: pivot.y - direction.y * distance,
    z: pivot.z - direction.z * distance
  }
}

function interpolateAngle (current, target, amount) {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current))
  return current + difference * amount
}

function selectNearbySectionMeshes (sectionMeshes, start, end, radius = 0, sectionSize = 16) {
  if (!sectionMeshes || !Number.isFinite(radius) || radius < 0 || !Number.isFinite(sectionSize) || sectionSize <= 0) return []
  if (![start.x, start.y, start.z, end.x, end.y, end.z].every(Number.isFinite)) return []

  // The camera probes are offset on two perpendicular axes, so each world-axis
  // bound can extend by up to sqrt(2) times the probe radius.
  const padding = Math.SQRT2 * radius
  const minX = Math.floor((Math.min(start.x, end.x) - padding) / sectionSize) * sectionSize
  const minY = Math.floor((Math.min(start.y, end.y) - padding) / sectionSize) * sectionSize
  const minZ = Math.floor((Math.min(start.z, end.z) - padding) / sectionSize) * sectionSize
  const maxX = Math.floor((Math.max(start.x, end.x) + padding) / sectionSize) * sectionSize
  const maxY = Math.floor((Math.max(start.y, end.y) + padding) / sectionSize) * sectionSize
  const maxZ = Math.floor((Math.max(start.z, end.z) + padding) / sectionSize) * sectionSize
  const nearbyMeshes = []

  for (let x = minX; x <= maxX; x += sectionSize) {
    for (let y = minY; y <= maxY; y += sectionSize) {
      for (let z = minZ; z <= maxZ; z += sectionSize) {
        const mesh = sectionMeshes[`${x},${y},${z}`]
        if (mesh) nearbyMeshes.push(mesh)
      }
    }
  }

  return nearbyMeshes
}

function resolveBoomDistance (distance, hitDistances, clearance = 0.16) {
  const validHits = hitDistances.filter((hit) => Number.isFinite(hit) && hit >= 0)
  if (validHits.length === 0) return distance
  const nearest = Math.min(...validHits)
  return Math.max(MIN_BOOM_DISTANCE, Math.min(distance, nearest - clearance))
}

module.exports = { cameraPosition, interpolateAngle, resolveBoomDistance, selectNearbySectionMeshes, viewDirection }
