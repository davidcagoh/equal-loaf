# Equal Loaf

Local Minecraft village demo for the **Conversation as the Interface** track. The default viewer keeps its existing ambient audio and push-to-talk interface. The native resident audio path is opt-in and supports one selected nearby resident at a time; the owner has accepted that proximity interaction. Conversation quality remains exploratory. Autonomous multi-party resident conversations are not implemented.

## Quickstart

Requirements: Bash, Node.js 22.6 or newer, npm, Java 21 or newer, Python 3, `curl`, `nc`, `rg` (ripgrep), and `shasum`. The launcher uses local loopback ports 25565, 8001, 3000, and 3001; choose different viewer ports if those are occupied.

1. Install the Minecraft adapter dependencies:

   ```sh
   npm ci --prefix packages/minecraft
   ```

2. Prepare the local Minecraft 1.21.11 server files. This downloads Mojang's server jar, verifies its published SHA-1, and leaves EULA acceptance for you:

   ```sh
   scripts/prepare-minecraft-world.sh
   ```

3. Read the Minecraft EULA. If you accept it, change `eula=false` to `eula=true` in the generated `eula.txt`. Its default location is `${XDG_CACHE_HOME:-$HOME/.cache}/boson/minecraft-1.21.11/eula.txt`; `BOSON_MC_DIR` can select another world directory. The launcher refuses to start until this file says `eula=true`.

4. To enable native Boson Realtime voice, copy `.env.example` to `.env` and replace its placeholder with your own `BOSON_API_KEY`. Without a key, the world and viewer still run, but native voice is unavailable. The launcher loads `.env` automatically when present.

5. Start the local demo:

   ```sh
   scripts/start-village-demo.sh
   ```

   Open the printed viewer URL and append `?nativeResidentAudio=1` to try the native resident audio interface. Walk close to a villager, click **Talk to a nearby villager**, allow microphone access when prompted, then hold **P** (or hold the button) while speaking. Audio capture is user initiated and stops when the hold ends. Use Ctrl+C in the launcher terminal to stop the demo.

The launcher starts loopback-only services and a local account-free explorer. `BOSON_MC_PLAYER`, `BOSON_EXPLORER_VIEWER_PORT`, `BOSON_COMPANION_VIEWER_PORT`, and `BOSON_MC_DIR` can override the documented defaults. Keep the viewer local; no public URL is provided.

## Native voice shape and current scope

The server selects the nearby resident and holds the Boson API key. It requests a short-lived Realtime client secret and gives that scoped credential to the browser; the browser then connects to Boson Realtime. The browser does not receive the long-lived API key. Player microphone audio is sent only during an explicit hold. Resident output is positioned against the resident and listener positions while moving.

This is currently an owner-accepted one-to-one proximity conversation path, not a verified full-village social simulation. Multi-party native dialogue, autonomous resident reactions, and complete physical hearing semantics remain unfinished. Native mode is opt-in; the regular viewer remains the default.

### Example prompts

- **“What do you do around here?”** Expect the selected resident to describe their role and everyday motive from their provided context; the wording varies.
- **“What did Anna say about the garden?”** If that speech is in the resident's recent attributed memory, expect it to be presented as something Anna said, not as confirmed fact.
- **“Could you help me with that?”** Expect a conversational reply or follow-up question. Dialogue does not itself change the Minecraft world or perform an action.
