const crypto = require('node:crypto');

function randomChar(chars) {
  return chars[crypto.randomInt(0, chars.length)];
}

function shuffle(chars) {
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
  }
  return chars;
}

function generateStrongPassword(length = 20, useSymbols = true) {
  if (!Number.isInteger(length) || length < 12) {
    throw new Error('Password length must be an integer of at least 12.');
  }

  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const symbols = '!@#$%^&*()-_=+[]{};:,.?';

  const requiredGroups = [lowercase, uppercase, digits];
  if (useSymbols) {
    requiredGroups.push(symbols);
  }

  const allChars = requiredGroups.join('');
  const passwordChars = requiredGroups.map((group) => randomChar(group));

  while (passwordChars.length < length) {
    passwordChars.push(randomChar(allChars));
  }

  return shuffle(passwordChars).join('');
}

function parseArgs(argv) {
  const options = {
    length: 20,
    useSymbols: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-symbols') {
      options.useSymbols = false;
      continue;
    }

    if (arg === '-l' || arg === '--length') {
      const nextValue = argv[index + 1];
      options.length = Number.parseInt(nextValue, 10);
      index += 1;
    }
  }

  return options;
}

function main() {
  try {
    const { length, useSymbols } = parseArgs(process.argv.slice(2));
    const password = generateStrongPassword(length, useSymbols);
    console.log(password);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  generateStrongPassword,
};
