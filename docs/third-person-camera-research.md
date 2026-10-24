# Minecraft-style third-person follow camera

Research record for `boson-0sp.28.6`. Scope: vanilla Java camera behavior and how to reproduce its relevant behavior in Boson's browser-based Prismarine Viewer. This documents a proposed implementation; it does not change the viewer.

## Main finding

Minecraft does not ask the server to place a third-person camera with a camera packet. The Java client owns its camera. The protocol carries player position and view rotation (yaw and pitch); a vanilla client uses its locally selected camera mode to render either first person or third person. For Boson, the browser viewer must construct the third-person camera from the explorer bot's live entity position, yaw, and pitch.

The camera should be **heading-locked**: follow the explorer, stay behind the direction they are looking, and look along that same direction. Do not drive it from body yaw or `headYaw`.

## What the sources establish

### Protocol and rotation semantics

- The 1.21.11 Prismarine protocol schema has serverbound `position_look` and `look` packets carrying `yaw` and `pitch`, and a clientbound player `position` packet that can also set yaw and pitch. Those packets contain player movement/look state, not a third-person camera position or camera mode. [Prismarine `minecraft-data` protocol schema for 1.21.11](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.21.11/protocol.json)
- Protocol yaw is not conventional compass yaw: the documented view-direction vector for angles in radians is `(-cos(pitch) * sin(yaw), -sin(pitch), cos(pitch) * cos(yaw))`; pitch `0` is level, negative is up, and positive is down. [Java protocol reference](https://c4k3.github.io/wiki.vg/Protocol.html)
- Mineflayer converts protocol angles into its own entity convention and stores `bot.entity.yaw` and `.pitch` in radians. Its view vector is `(-sin(yaw) * cos(pitch), sin(pitch), -cos(yaw) * cos(pitch))`. Use these converted values consistently; do not re-apply the protocol angle conversion. [Mineflayer conversion source](https://github.com/PrismarineJS/mineflayer/blob/master/lib/conversions.js), [Mineflayer view-ray source](https://github.com/PrismarineJS/mineflayer/blob/master/lib/plugins/ray_trace.js)
- `headYaw` is a separate entity-head orientation in the protocol (for example, `entity_head_rotation` has a `headYaw` field). It is used to orient a rendered entity's head; it is not the local player's camera view rotation. Mineflayer's player aim/view direction is represented by `yaw` and `pitch`. [1.21.11 protocol schema](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.21.11/protocol.json)

### Vanilla camera behavior

- The 1.21.11 client camera API is updated from a focused entity with a `tickProgress` interpolation value. It exposes yaw/pitch rotation, a third-person state, a base camera distance, and `clipToSpace(distance)` for collision-aware distance adjustment. [Yarn 1.21.11 Camera API](https://maven.fabricmc.net/docs/yarn-1.21.11%2Bbuild.6/net/minecraft/client/render/Camera.html), [Yarn 1.21.11 Camera mappings](https://github.com/FabricMC/yarn/blob/1.21.11/mappings/net/minecraft/client/render/Camera.mapping)
- Rear third-person places the camera behind the focused player's look direction. The standard distance is four blocks, shortened when world geometry obstructs the view. [Third-person view reference](https://minecraft.wiki/w/Third-person_view)
- Vanilla's camera is client behavior. The server's role is to provide the focused entity's world state; a web renderer that receives only a position stream must implement camera positioning, angle interpolation, and collision handling itself.

The mapping/API sources verify the camera's relevant update, rotation, and clipping hooks. They are not a full readable decompilation of Mojang's implementation, so this note does not claim byte-for-byte parity in all edge cases (vehicles, front view, sleeping, camera-distance attributes, or camera effects).

## Boson implementation today

Local inspection was against `mineflayer@4.39.0` and `prismarine-viewer@1.33.0` in `packages/minecraft`:

1. Prismarine Viewer defaults to `firstPerson: false`. Its Mineflayer bridge emits `{ pos, yaw, addMesh: true }`; it adds pitch only when `firstPerson` is enabled. [Upstream bridge](https://github.com/PrismarineJS/prismarine-viewer/blob/master/lib/mineflayer.js)
2. The normal browser path initializes Three.js `OrbitControls`. The local postinstall patch follows position by translating both camera and orbit target by the bot's position delta. It does not rotate the offset when the bot's yaw changes, does not receive pitch, and does not clip the camera against blocks. See `packages/minecraft/scripts/apply-prismarine-viewer-fix.cjs` in this repo.
3. Prismarine Viewer already has a separate first-person path that sets camera position to the bot's eye and camera rotation from yaw/pitch. The browser handler returns immediately from this path before creating/updating its own avatar mesh, so simply enabling `firstPerson` would not satisfy the visible third-person explorer requirement. The README identifies OrbitControls as its default third-person mode. Neither path is a heading-locked third-person follow camera. [Viewer API](https://github.com/PrismarineJS/prismarine-viewer/blob/master/viewer/README.md), [browser camera path](https://github.com/PrismarineJS/prismarine-viewer/blob/master/lib/index.js)
4. The viewer's own `botMesh` is added to the scene in the normal path. A custom follow camera can keep that avatar visible in the foreground while aiming from behind it.

## Implementation specification

### Data and coordinate contract

- Extend the local `position` event to always carry finite `pos`, `yaw`, and `pitch` from `bot.entity`, while preserving `addMesh`. These are Mineflayer values in radians, not raw protocol degrees. Do not use `headYaw`.
- Treat `bot.entity.position` as feet position. Use `bot.entity.eyeHeight` (with the existing 1.6-block fallback) to define the look pivot. Keep the body mesh at feet position.
- In the existing Three.js camera coordinate convention, compute the look direction as:

  ```js
  forward = new Vector3(
    -Math.sin(yaw) * Math.cos(pitch),
     Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  )
  ```

- For rear view, target/pivot is the interpolated eye position and desired camera position is `pivot - forward * distance`. Orient the camera to look at the pivot (equivalently, use the same yaw/pitch convention). This makes yaw changes swing the camera behind the player, and pitch changes raise/lower it along the viewed direction.
- Start with a configurable desired distance near vanilla's four-block distance; a slightly shorter value may better serve the requested close village-walk framing. Preserve the possibility of manual zoom if desired, but zoom must change only boom length, not detach the camera heading from the explorer.

### Update and collision behavior

- Smooth position and angles on the render loop, not by snapping once per network event. Interpolate yaw using the shortest wrapped angular difference so crossing `+π/-π` does not spin the long way. Keep camera and avatar updates synchronized.
- Shorten the boom against the same loaded block geometry used for rendering. A single center ray can miss a wall edge that clips the camera body; use a small camera-volume approximation (vanilla uses multiple offset collision probes) and choose the nearest obstruction distance, with a small clearance margin. Never allow a collision adjustment to move the camera through opaque geometry. Ease out more slowly than the camera retracts to reduce popping.
- Prefer clipping the camera distance over changing the look target. Keep a small minimum separation from the avatar to prevent the camera intersecting the explorer mesh; if the remaining space is too small, explicitly fall back to a close/first-person view rather than rendering through a wall.
- Make the camera controls non-orbiting while heading lock is active. If manual zoom is retained, prevent rotate/pan input from making the viewer appear to lose the explorer. A deliberate user camera override can be a separate mode later.

## Verification plan for the implementation task

1. Verify facing behavior at four cardinal yaw directions and a diagonal; the avatar should remain in the foreground while the scene swings to the direction the avatar faces.
2. Verify level, up, and down pitch; camera position and view direction should stay aligned with the explorer's gaze, without inverted vertical response.
3. Turn in place and cross the `-π/+π` yaw wrap; there should be no orbit lag, long spin, or heading reversal.
4. Walk backward and sideways; the camera should still follow the view heading, not movement velocity or body animation.
5. Rotate near a wall edge, enter a doorway, and pass below a ceiling; the boom should retract before the camera clips through blocks and ease back when clear.
6. Cross chunk boundaries and reconnect/reload the viewer; camera initialization should use the current pose, not an origin/default orbit position.
7. Keep the camera stable while the demo NPCs speak and move; avatar visibility and subtitle/voice panel should remain usable.

## Sources

- [PrismarineJS `minecraft-data` 1.21.11 protocol JSON](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.21.11/protocol.json)
- [wiki.vg Java protocol reference](https://c4k3.github.io/wiki.vg/Protocol.html)
- [Fabric Yarn 1.21.11 `Camera` API](https://maven.fabricmc.net/docs/yarn-1.21.11%2Bbuild.6/net/minecraft/client/render/Camera.html)
- [Fabric Yarn 1.21.11 `Camera` mappings](https://github.com/FabricMC/yarn/blob/1.21.11/mappings/net/minecraft/client/render/Camera.mapping)
- [Minecraft Wiki: third-person view](https://minecraft.wiki/w/Third-person_view)
- [Prismarine Viewer Mineflayer bridge](https://github.com/PrismarineJS/prismarine-viewer/blob/master/lib/mineflayer.js)
- [Prismarine Viewer browser camera code](https://github.com/PrismarineJS/prismarine-viewer/blob/master/lib/index.js)
- [Prismarine Viewer API](https://github.com/PrismarineJS/prismarine-viewer/blob/master/viewer/README.md)
- [Mineflayer angle conversion](https://github.com/PrismarineJS/mineflayer/blob/master/lib/conversions.js)
- [Mineflayer view direction](https://github.com/PrismarineJS/mineflayer/blob/master/lib/plugins/ray_trace.js)
