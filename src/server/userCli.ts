import { addCredits, createUser, listUsers, rotateKey } from './accounts';

/**
 * Server-side user admin (run on the server):
 *   npm run user -- add <email> [credits]     create a user, print the access key ONCE
 *   npm run user -- credit <email> <n>        add (or with a negative n remove) credits
 *   npm run user -- key <email>               issue a new access key (old one stops working)
 *   npm run user -- list
 */
const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'add' && a) {
    const { user, accessKey } = createUser(a, Number(b ?? 0));
    console.log(`\n  user ${user.email}: ${user.freeLeft} free + ${user.credits} paid generations`);
    console.log(`  ACCESS KEY (shown once, give it to the user): ${accessKey}\n`);
  } else if (cmd === 'credit' && a && b) {
    const u = addCredits(a, Number(b));
    console.log(`  ${u.email}: ${u.freeLeft} free + ${u.credits} paid generations`);
  } else if (cmd === 'key' && a) {
    console.log(`  NEW ACCESS KEY for ${a} (shown once): ${rotateKey(a)}`);
  } else if (cmd === 'list') {
    for (const u of listUsers()) console.log(`  ${u.email.padEnd(32)} free ${u.freeLeft}  paid ${u.credits}  used ${u.used}  since ${u.createdAt.slice(0, 10)}`);
  } else {
    console.log('usage: npm run user -- add <email> [credits] | credit <email> <n> | key <email> | list');
    process.exit(1);
  }
} catch (e: any) {
  console.error(`  ${e.message}`);
  process.exit(1);
}
