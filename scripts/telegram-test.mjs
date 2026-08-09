#!/usr/bin/env node
/**
 * Prove the Telegram wiring works, before relying on it in an incident.
 *
 *   npm run telegram:test
 *
 * Secrets set with `wrangler secret put` are write-only — nothing can read
 * them back, including this script. So it asks for the token and chat id,
 * sends one message, and keeps neither. That is the point: the thing being
 * tested is whether THOSE values reach THAT chat, which is exactly the
 * question a green deploy cannot answer.
 *
 * Nothing is stored, echoed, or written to disk. Run it as often as you like.
 */

import * as readline from 'node:readline';

function ask(prompt, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const repaint = () => {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(prompt);
      };
      process.stdin.on('data', repaint);
      rl.question(prompt, (a) => {
        process.stdin.removeListener('data', repaint);
        rl.close(); process.stdout.write('\n'); resolve(a.trim());
      });
    } else {
      rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); });
    }
  });
}

const main = async () => {
  console.log('\nTelegram check — sends one message and stores nothing.\n');

  const token = process.env.TELEGRAM_BOT_TOKEN || await ask('Bot token: ', true);
  if (!token) { console.error('No token.'); process.exit(1); }

  // getMe first: it separates "the token is wrong" from "the chat id is wrong",
  // which are the two failures and look identical from sendMessage alone.
  let me;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    me = await res.json();
    if (!me.ok) {
      console.error(`\nTelegram rejected the token: ${me.description ?? res.status}`);
      console.error('Get a fresh one from @BotFather with /token.');
      process.exit(1);
    }
  } catch (err) {
    console.error(`\nCould not reach Telegram: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n  Token is valid — bot is @${me.result.username}\n`);

  let chat = process.env.TELEGRAM_CHAT_ID || await ask('Chat id (blank to look it up): ');

  if (!chat) {
    // getUpdates only returns anything if a message was sent TO the bot, which
    // is also the step that lets a bot message a private chat at all.
    console.log('\n  Send any message to the bot in Telegram now, then press Enter.');
    await ask('  Ready: ');
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const data = await res.json();
    const chats = [...new Map((data.result ?? [])
      .map((u) => u.message?.chat).filter(Boolean)
      .map((c) => [c.id, c])).values()];

    if (!chats.length) {
      console.error('\n  No messages seen. The bot cannot start a conversation —');
      console.error('  you have to message it first. Open Telegram, find '
                    + `@${me.result.username}, and send anything.`);
      process.exit(1);
    }
    for (const c of chats) {
      console.log(`    ${c.id}  ${c.title ?? [c.first_name, c.last_name].filter(Boolean).join(' ')}`
                  + ` (${c.type})`);
    }
    chat = chats.length === 1 ? String(chats[0].id) : await ask('\n  Which id: ');
    console.log();
  }

  const text = [
    'Diamond Park — test message',
    '',
    'If you can read this, alerting works:',
    '  fatal and error codes arrive here immediately',
    '  warnings arrive once a day in the digest',
    '',
    new Date().toISOString(),
  ].join('\n');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  const out = await res.json();

  if (!out.ok) {
    console.error(`\nSend failed: ${out.description ?? res.status}`);
    if (String(out.description ?? '').includes('chat not found')) {
      console.error('That chat id is wrong, or the bot was never messaged from it.');
    }
    process.exit(1);
  }

  console.log('Sent. Check Telegram.\n');
  console.log('If it arrived, set these on BOTH deployments — they are separate');
  console.log('Workers over one database, so secrets on one do not reach the other:\n');
  console.log('  npx wrangler secret put TELEGRAM_BOT_TOKEN');
  console.log('  npx wrangler secret put TELEGRAM_CHAT_ID');
  console.log(`  (chat id: ${chat})\n`);
  console.log('  cd pages && npx wrangler secret put TELEGRAM_BOT_TOKEN');
  console.log('  cd pages && npx wrangler secret put TELEGRAM_CHAT_ID\n');
  console.log('Then confirm with: npm run doctor\n');
};

main().catch((err) => { console.error('\nFailed:', err.message); process.exit(1); });
