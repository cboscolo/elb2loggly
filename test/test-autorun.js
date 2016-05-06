var chai = require('chai');
var rewire = require('rewire');
var AWSMock = require('mock-aws-s3');
var PassThrough = require('stream').PassThrough;
var glob = require('glob');

var elb2loggly = rewire('../elb2loggly');

chai.config.includeStack = true;

global.expect = chai.expect;
global.AssertionError = chai.AssertionError;
global.Assertion = chai.Assertion;
global.assert = chai.assert;

/////////////////////
//
// This test script looks for log files in the test directory of the 
// format 'autotest-{somename}.log' passes it to th elb2loggly lambda function
// and compares the resulting JSON that would be sent to loggly to the coresponding
// 'autotest-{somename}.json'. Each log file should have only ONE log in it.
// 
// Adding additional test logs and coresponding result JSON is easy.  Just add the two
// files to the test directory.



// Configure AWSMock to look for files in local dir and
// to serve the in a bucket called 'test'

AWSMock.config.basePath = '.'
var s3 = AWSMock.S3({
   params: { Bucket: 'test' }
});

// The mock-aws-s3 node module does not implement getBucketTagging. This could be extended to have per bucket test
// values, but for now will just return one set of values. 

s3.getBucketTagging = function(params, cb) {
	var bucket_tags = { TagSet: 
		[ { Key:'loggly-customer-token', Value:'foo' },
		  { Key:'elb2loggly-private-url-params', Value:'authToken/4' } ]  // Used to test the private-url-param behavior
	};
	cb(null, bucket_tags);
};

elb2loggly.__set__("s3", s3);

var mock_stream =  new PassThrough();
var request_mock = {
	post: function(url) { return mock_stream; }
}

elb2loggly.__set__("request", request_mock);

// Use rewire to supress the log messages from elb2loggly
elb2loggly.__set__("console", { log: function() {}, error: function(){} });


var testOneLog = function( log_filename, json_results_filename ) {
	
	describe('Parsing ' + log_filename, function () {

		var data = null;

		before(function(chai_done){
			
			mock_stream = new PassThrough();
			request_mock = {
				post: function(url) { return mock_stream; }
			}

			var event = { 
				Records: [{ 
					s3: { 
						bucket: { name: 'test' }, 
						object: { key: log_filename, size: 1 } 
					}
				}] 
			};

			var context = {
				fail: function(error) { 
					chai_done(error); 
				},
				
				succeed: function(result) { 
					chai_done() 
				},

				done: function (error, result) {
					if (error === null || typeof(error) === 'undefined') {
						context.succeed(result);
					} else {
						context.fail(error);
					}
				}
			}

			mock_stream.on('data', function(chunk) { 
				if ( chunk ) { data = chunk.toString('utf8') };
			});

			elb2loggly.handler(event, context);
		});

		it('should produce a json object that matches ' + json_results_filename, function () {

			var json_results = require(json_results_filename);

			var parsed_log = JSON.parse(data);
			expect( parsed_log ).to.deep.equal( json_results );

	    });
	});
};


//testFileParse('./test1.log', './test1.json');
var cwd = process.cwd();
process.chdir('test');

glob.sync('autotest-*.log').forEach( function(logfile_name) {
	var basename = logfile_name.split('.')[0];

	testOneLog('./' +logfile_name, './' + basename + '.json');
});

process.chdir(cwd);

