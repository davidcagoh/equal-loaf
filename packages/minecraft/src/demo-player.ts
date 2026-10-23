import mineflayer from 'mineflayer';

const host = process.env.BOSON_MC_HOST ?? '127.0.0.1';
const port = Number(process.env.BOSON_MC_PORT ?? 25565);
const username = process.env.BOSON_MC_PLAYER ?? 'DemoPlayer';
if (!new Set(['127.0.0.1', 'localhost', '::1']).has(host)) throw new TypeError('Demo player only connects to a loopback server');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('BOSON_MC_PORT must be a valid TCP port');
if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new TypeError('BOSON_MC_PLAYER must be a 3–16 character Minecraft username');
const bot = mineflayer.createBot({ host, port, username, version: '1.21.11', auth: 'offline' });

let stopping = false;
const stop = () => {
  stopping = true;
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  bot.quit('Demo player stopped');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

bot.once('spawn', () => {
  process.stdout.write(`Account-free demo player ${username} spawned at ${bot.entity.position.floored().toString()}\n`);
  void (async () => {
    const headings = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    let index = 0;
    while (!stopping) {
      try {
        await bot.look(headings[index % headings.length], 0);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await new Promise((resolve) => setTimeout(resolve, 1800));
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        process.stdout.write(`DemoPlayer moved to ${bot.entity.position.floored().toString()}\n`);
        index += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error) {
        if (!stopping) process.stderr.write(`Demo player movement failed: ${error instanceof Error ? error.message : String(error)}\n`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  })();
});

bot.on('error', (error) => process.stderr.write(`Demo player error: ${error.message}\n`));
bot.on('end', () => { stopping = true; });
