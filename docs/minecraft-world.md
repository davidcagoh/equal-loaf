# Minecraft test world

The world bootstrap targets Minecraft Java 1.21.11, which is on Mineflayer's tested-version list. It downloads the official Mojang server jar into the local cache and verifies the jar against the SHA-1 in Mojang's version manifest. It does not place server binaries or generated world files in the repository.

## Prepare and launch

1. Install Java 21 or newer. If it is not first on `PATH`, set `JAVA_BIN` to the Java 21 executable.
2. Run `bash scripts/prepare-minecraft-world.sh`. This writes the server jar, checksum metadata, loopback-only server settings, and an `eula=false` file.
3. Review the [Minecraft EULA](https://aka.ms/MinecraftEULA). If you agree to it, set the local cache's `eula.txt` to `eula=true`. The current local cache has been accepted by the operator; a new machine must review and accept it separately.
4. Run `bash scripts/start-minecraft-world.sh`. The server listens only on `127.0.0.1`, uses offline mode for this local test, peaceful difficulty, and a pinned seed. Do not expose this server to a network.
5. Stop the foreground server with Ctrl+C. Run `bash scripts/reset-minecraft-world.sh` to restore the canonical settings and move the prior world into a timestamped backup.

The canonical preset is a superflat forest biome. Biome features are enabled to provide reachable trees on otherwise clear terrain. Once the EULA is accepted, inspect and record the generated spawn layout; adjust the seed only if that evidence shows it misses the intended scene. The runtime bot-join and observation gate is validated by the Minecraft adapter task.

`BOSON_MC_DIR` can point the scripts to a different cache directory. The default is `${XDG_CACHE_HOME:-$HOME/.cache}/boson/minecraft-1.21.11`. The directory contains the server jar, world, configuration, and reset backups.

The server is intentionally in offline mode and bound to loopback. A Minecraft account is not required for the companion or the local `DemoPlayer` test driver. Do not expose this unauthenticated server beyond the local machine. Use Java 21 or newer; Homebrew's `openjdk@21` can be selected through `JAVA_BIN` when it is not the system default.

After installing the adapter dependencies with `npm ci --prefix packages/minecraft`, start the companion with `npm --prefix packages/minecraft start`. To add an account-free moving target for scripted follow/stop/return checks, run `npm --prefix packages/minecraft run demo-player` in another terminal and set `BOSON_MC_PLAYER=DemoPlayer` for the companion process.

When the companion connects, it also starts Prismarine Viewer on `127.0.0.1:3000` (override the port with `BOSON_VIEWER_PORT`). The companion dashboard embeds this live browser-rendered 3D view. The viewer listener is explicitly restricted to loopback because the package does not provide authentication. Prismarine Viewer upstream currently advertises support only through 1.21.4; this project pins 1.33.0 and requires a local render smoke check against the selected server version before relying on recordings after upgrades.
