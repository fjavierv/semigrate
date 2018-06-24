#!/usr/bin/env node

var chalk = require('chalk');
var semigrate = require('./semigrate');

function fatal (message) {
  console.error('\n' + chalk.bold.red(message));
  process.exit(-1);
}

function quit () {
  process.exit(0);
}


if (require.main === module){

  var argv = require('yargs')
      .strict()
      .usage('Usage: $0 [options]')
      .wrap(80)
      .options('reset', {
        alias: 'r',
        describe: 'Reset the migration information in the database'
      })
      .options('database', {
        describe: 'Specify database to migrate',
        demand: true
      })
      .options('directory', {
        default: 'migrations/',
        describe: 'Specify where to locate the migrations.'
      })
      .options('colors', {
        default: true,
        describe: 'Use colors in the output'
      })
      .options('migrate', {
        default: true,
        describe: "Apply the migration scripts. You can override the default value of this option passing `--no-migrate'."
      })
      .options('dry-run', {
        alias: 'n',
        describe: 'Show the steps but do not commit changes to the database'
      })
      .options('load', {
        alias: 'l',
        describe: 'Load a file after the migration is completed'
      })
      .version(semigrate.version, 'version')
      .help('help')
      .alias('help', 'h')
      .argv;

  semigrate(argv).done(quit, fatal);
}
