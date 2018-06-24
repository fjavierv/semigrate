// migrate.js ---

var fs = require('fs');
var path = require('path');
var _ = require('lodash');
var Q = require('q');
var pg = require('pg');
var semver = require('semver');
var chalk = require('chalk');

var theme = {
  underline: chalk.underline,

  notice: chalk.gray.dim,

  success: chalk.bold.green,
  warn: chalk.bold.yellow,
  error: chalk.bold.red,

  step: chalk.blue,
  stepResult: chalk.bold.blue,

  version: chalk.white
};


function qMapSerial (array, func) {
  return _.reduce(array, function(last, x){ 
    return last.then(function(){ return func(x); });
  }, Q(null));
}


function pad (n, width, char, right) {
  char = char || ' ';
  var length = (''+n).length;
  var padSize = Math.max(0, width-length+1);
  var padstr = (new Array(padSize)).join(char);
  return right? n + padstr: padstr + n;
}


var report = {
  info: function (message) {
    process.stdout.write(theme.step(message));
  },
  status: function (string) {
    process.stdout.write(theme.stepResult(string) + '\n');
  },

  migration: function(id, title, line) {
    var version = pad(id, 4);
    var summary = '   ';
    if (id)
      summary += chalk.white.bold(version) + chalk.dim(': ');
    summary += chalk.bold.blue(title) + ' ';

    var width = 100;

    if (line)
      summary = pad(summary, width, chalk.dim.gray('.'), true);

    process.stdout.write(summary);
  },

  load: function(filename) {
    var summary = chalk.blue('Loading ') + chalk.blue(filename) + ' ';
    process.stdout.write(summary);
  },

  step: function (title) {
    var summary = '          ' + chalk.magenta(title) + ' ';
    var width = 72;
    summary = pad(summary, width, chalk.dim.gray('.'), true);
    process.stdout.write(summary);
  },

  done: function () {
    var dark = chalk.gray.dim;
    var success = chalk.green.bold;
    var result = dark('[') + success('done') + dark(']');
    process.stdout.write(result + '\n');
  }

};

function validMigrationType (file){
  var extname = path.extname(file);
  return extname === '.sql' || extname === '.js';
}


function parseMigrationSpec (spec) {
  var matches = path.basename(spec).match(/^([^-]*)-(.*)$/);
  if (!matches) return;

  var version = semver.valid(matches[1]);
  if (!version) return;

  var multiple;
  var files = [];

  function relativePath (file){
    return path.join(spec,file);
  }

  if (fs.statSync(spec).isDirectory()){
    multiple = true;
    files = _.map(fs.readdirSync(spec), relativePath).filter(validMigrationType);
  } else {
    multiple = false;
    if (!validMigrationType(spec))
      return;
    files = [spec];
  }

  return {
    "version": version,
    "title": matches[2],
    "multiple": multiple,
    "path": spec,
    "files": files
  };
}

// Return an array of migration scripts in the migration directory
// ordered by version. Each element in the array is an object of the
// form:
//
//    {version: NNN, title: ..., path: ..., files: []}
//
function list (directory) {
  return _(fs.readdirSync(directory || '.'))
    .map(function(name){
      return path.join(directory, name);
    })
    .map(parseMigrationSpec)
    .compact()
    .sort(function(m1,m2){
      return semver.compare(m1.version, m2.version);
    })
    .valueOf();
}


function Connection (client, done) {
  this.client = client;
  this.done = done;
}

Connection.prototype.query = function(statement, parameters) {
  var conn = this;
  parameters = parameters || [];
  return Q.Promise(function(resolve, reject){
    conn.client.query(statement, parameters, function(err, result){
      return err? reject(err): resolve(result.rows);
    });
  });
};

function connect (database) {
  var deferred = Q.defer();
  var promise = deferred.promise;
  report.info(theme.notice('Connecting to database ' + theme.underline(database) + '...') + '\n');
  pg.connect(database, function(err, client, done) {
    if (err) return deferred.reject(err);
    var conn = new Connection(client, done);
    client.query('BEGIN', function(err){
      if (err)
        deferred.reject(err);
      else
        deferred.resolve(conn);
    });
  });
  return promise;
}



function initialize () {
  return function (conn){
    report.info('Initializing migration schema...');
    return Q.all([
      conn.query('CREATE SCHEMA IF NOT EXISTS semigrate'),
      conn.query(['CREATE TABLE IF NOT EXISTS semigrate.migrations (',
                  '   version varchar(32) primary key,',
                  '   date timestamptz default now()',
                  ')'].join(''))
    ]).then(function(){
      report.status('done');
    }).thenResolve(conn);
  };
}


function detect (options){
  options = options || {};
  return function (conn){
    return conn.query('SELECT version FROM semigrate.migrations')
      .then(function(result){
        var versions = _.map(result, 'version');
        var version = semver.maxSatisfying(versions, '*');
        if (version !== null && !options.quiet){
          report.info('Current version...');
          report.status(theme.version(version));
        }
        return version;
      });
  };
}


function runStep (filename, conn, verbose) {
  var promisee;

  if (verbose)
    report.step(path.basename(filename));

  switch (path.extname(filename)){
  case '.sql':
    var script = fs.readFileSync(filename, {encoding: 'utf-8'});
    promise = conn.query(script);
    break;
  case '.js':
    promise = Q(require(filename)(conn));
    break;
  default:
    promise = Q.when(null);
    break;
  }

  return promise.then(function(){
    if (verbose)
      report.done();
  });
}



function run (migration, conn) {
  var steps;

  if (migration.multiple){
    steps = qMapSerial(migration.files, function(file){
      return runStep(file, conn, true);
    });
  }
  else
    steps = runStep(migration.path, conn, false);

  return steps.then(function(){
    return conn.query('INSERT INTO semigrate.migrations (version) VALUES ($1)', [migration.version]);
  });
}


function migrate (migrations) {
  return function (conn){
    // Try to detect the current version in the database. If an error
    // occur, restart the transaction and keep going, i.e. ignore the
    // error.
    var versionPromise = detect()(conn)
        .then(function(version){
          return version;
        }, function(reason){
          return Q.all([conn.query('ROLLBACK'), conn.query('BEGIN')]);
        });

    return versionPromise.then(function(version){
      return Q.Promise(function(resolve, reject, notify){

        migrations = _.filter(migrations, function(migration){
          return version === null || semver.gt(migration.version, version);
        });

        function resume () {
          var migration = migrations.shift();
          if (!migration) return resolve(conn);

          var multiple = migration.multiple;
          report.migration(migration.version, migration.title + (migration.multiple? '/': ''), !multiple);
          if (multiple) 
            console.log('');

          run(migration, conn).then(function(){
            if (!multiple)
              report.done();

            process.nextTick(resume);
          }, reject);
        }

        if (migrations.length !== 0)
          report.info('Migrating database...\n');

        // Start in the next iteraction of the event loop, so the
        // first notification can be catched.
        process.nextTick(resume);
      });
    });
  };
}


function load (scripts) {
  return function (conn){
    if (!_.isArray(scripts))
      scripts = [scripts];

    return qMapSerial(scripts, function(filename){
      var content = fs.readFileSync(filename, {encoding: 'utf-8'});
      report.load(filename);
      return conn.query(content).then(function(){
        console.log();
      });
    }).thenResolve(conn);
  };
}


function check (lastMigration) {
  return function (conn) {
    return detect({quiet: true})(conn)
      .then(function(version){
        console.log('');
        if (version === null || semver.gt(lastMigration, version))
          throw new Error('Database is out-of-date.');
        else if (semver.eq(lastMigration, version))
          console.log(theme.success('Database is up-to-date.'));
        else if (semver.satisfies(version, '^' + lastMigration)){
          console.log(theme.warn('WARNING: Database is newer than the code, but it is a compatible version.'));
        }
        else {
          throw new Error('Database version is ' + theme.underline('incompatible') +  ' with the current code.');
        }

        return conn;
      });
  };
}


function reset (){
  return function (conn) {
    report.info('Reseting database...');
    return conn.query('DELETE FROM semigrate.migrations')
      .then(function(){
        report.status('done');
        return conn;
      });
  };
}

function finish (){
  return function (conn){
    return conn.query('COMMIT').thenResolve(conn);
  };
}


function semigrate (config, callback) {
  chalk.enabled = config.colors;

  config = config || {};
  callback = callback || function(){};

  var migrations = list(config.directory || '.');
  var version = semver.maxSatisfying(_.map(migrations, 'version'), '*');

  return connect(config.database)
    .then(initialize())
    .then(config.reset? reset(): null)
    .then(config.migrate? migrate(migrations): null)
    .then(load(config.load || []))
    .then(!config['dry-run']? finish(): function(conn){
      report.info(theme.error('Reverting...\n'));
      return conn;
    })
    .then(check(version))
    .fin(callback.bind(null, null), callback.bind(null));
}


module.exports = semigrate;
semigrate.version = require('./package').version;
