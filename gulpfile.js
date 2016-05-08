var gulp = require('gulp');
var file = require('gulp-file');
var lint = require('gulp-eslint');
var mocha = require('gulp-mocha');
var zip = require('gulp-zip');
var del = require('del');
var install = require('gulp-install');
var lambda = require('gulp-awslambda');
var runSequence = require('run-sequence');

// Load the package file.
var pkg = require('./package');

var lambdaJobName = 'elb2loggly';

var deploymentZip = './' + lambdaJobName + '.zip';
var srcFile = './' + lambdaJobName + '.js';

var lambdaExecRole = 'arn:aws:iam::*:role/lambda_s3_exec_role';

// These config options are passed into the running Lambda func.
var cfg = {
  LOGGLY_TOKEN: null,
};

// Lambda config options.
var lambdaParams = {
  FunctionName: pkg.name, // required
  Description: pkg.description ? pkg.description : 'No description in package.json',
  Handler: lambdaJobName + '.handler',
  MemorySize: 128,
  Role: lambdaExecRole,
  Timeout: 300 // in seconds
};

var lambdaOpts = {region: 'us-west-2'};

// Clean out the dist folder and remove the zip file.
gulp.task('clean', function(cb) {
  del('./dist',
    del(deploymentZip, cb)
  );
});

// Run eslint.
gulp.task('lint', function() {
  return gulp.src('*.js')
    .pipe(lint())
    .pipe(lint.format())
    .pipe(lint.failOnError());
});

gulp.task('mocha', function() {
  return gulp.src(['test/**/*.js'], {read: false})
    .pipe(mocha({reporter: 'spec'}));
});

gulp.task('test', function() {
  return runSequence(
    'lint',
    'mocha'
  );
});

// Install npm packages to dist, ignoring devDependencies.
gulp.task('npm', function() {
  return gulp.src('./package.json')
    .pipe(gulp.dest('./dist/'))
    .pipe(install({production: true}));
});

// Write config file (JSON format)
gulp.task('cfg', function() {
  return file('cfg.json', JSON.stringify(cfg) + '\n', {src: true})
        .pipe(gulp.dest('dist/'));
});

// Add the JS files to dist
gulp.task('js', function() {
  return gulp.src(srcFile)
    .pipe(gulp.dest('dist/'));
});

// Now the dist directory is ready to go. Zip it.
// (Don't include the package.json that npm left there.)
gulp.task('zip', function() {
  return gulp.src(['dist/**/*', '!dist/package.json', 'dist/.*'])
    .pipe(zip(deploymentZip))
    .pipe(gulp.dest('./'));
});

// The Deploy script should pass in use: npm install --production
// to avoidpackaging dev packages in the deployed code.
gulp.task('deploy-lambda', function() {
  gulp.src(deploymentZip)
  .pipe(lambda(lambdaParams, lambdaOpts))
  .pipe(gulp.dest('.'));
});

gulp.task('package', function(cb) {
  return runSequence(
	'npm',
    ['js', 'cfg'],
    'zip',
    cb
    );
});

gulp.task('deploy', function(cb) {
  return runSequence(
    'package',
    'deploy-lambda',
    cb
    );
});

gulp.task('default', ['deploy']);

