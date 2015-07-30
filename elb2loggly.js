var aws = require('aws-sdk')
var s3 = new aws.S3({apiVersion: '2006-03-01'})

var _ = require('lodash')
  , async = require('async')
  , request = require('request')
  , Transform = require('stream').Transform
  , csv = require('csv-streamify')
  , JSONStream = require('JSONStream')

// Set LOGGLY_TOKEN to your Loggly customer token. It will look somethign like this:
// LOGGLY_TOKEN = 'ea5058ee-d62d-4faa-8388-058646faa747'
// Preferably, you should set the tag 'loggly-customer-tag' on the S3 bucket.


// Optionally set a LOGGLY_TAG if you want to tag these logs in a certain way. For example:
// LOGGLY_TAG = 'aws-elb-logs'
// Preferably, you should set the 'loggly-tag' on the S3 bucket.

LOGGLY_URL_BASE = 'https://logs-01.loggly.com/bulk/'
BUCKET_LOGGLY_TOKEN_NAME = 'loggly-customer-token'
BUCKET_LOGGLY_TAG_NAME = 'loggly-tag'

// Used if no S3 bucket tag soesn't contain customer token.
// Note: You either need to specify a cutomer token in this script or via the S3 bucket tag else an error is logged.
DEFAULT_LOGGLY_URL = null

if ( typeof LOGGLY_TOKEN !== 'undefined' ) { 
    DEFAULT_LOGGLY_URL = LOGGLY_URL_BASE + LOGGLY_TOKEN;

    if ( typeof LOGGLY_TAG !== 'undefined' ) {
	DEFAULT_LOGGLY_URL += '/tag/' + LOGGLY_TAG;
    }
}

if ( DEFAULT_LOGGLY_URL ) console.log('Loading elb2loggly, default Loggly endpoint: ' + DEFAULT_LOGGLY_URL);
else console.log('Loading elb2loggly, NO default Loggly endpoint, must be set in bucket tag ' + BUCKET_LOGGLY_TOKEN_NAME );

// AWS logs contain the following fields: (Note: a couple are parsed from within the field.)
// http://docs.aws.amazon.com/ElasticLoadBalancing/latest/DeveloperGuide/access-log-collection.html
var COLUMNS = [
              'timestamp',
              'elb',
              'client_ip', 'client_port', // split from client
              'backend', 'backend_port',
              'request_processing_time',
              'backend_processing_time',
              'response_processing_time',
              'elb_status_code',
              'backend_status_code',
              'received_bytes',
              'sent_bytes',
              'request_method', // Split from request
              'request_url',     // Split from request
              'user_agent',
              'ssl_cipher',
              'ssl_protocol'
              ];

// Parse elb log into component parts.
var parse_s3_log = function(data, encoding, done) {
  var expectedFields = 15;
  if ( data.length == expectedFields ) {

      // Split clientip:port and backendip:port at index 2,3
      data.splice(3,1,data[3].split(':'))
      data.splice(2,1,data[2].split(':'))
      
      // Pull the method from the request.  (WTF on Amazon's decision to keep these as one string.)
      var requestIndex = data.length - 4;
      var url_mash = data[requestIndex];

      url_mash = url_mash.split(' ',2)

      data.splice(requestIndex,1, url_mash);
      data = _.flatten(data)

      if ( data.length == COLUMNS.length ) {
        this.push(_.zipObject(COLUMNS, data));
      } else {
	      console.error('ELB log length ' + data.length + ' did not match COLUMNS length ' + COLUMNS.length)
      }
      done();
  }
  else {
    done("expecting " + expectedFields + " actual fields " + data.length);
  }

};


exports.handler = function(event, context) {
//   console.log('Received event');

   // Get the object from the event and show its content type
   var bucket = event.Records[0].s3.bucket.name;
   var key  = event.Records[0].s3.object.key;
   var size = event.Records[0].s3.object.size;

   if ( size == 0 ) {
       console.log('S3ToLoggly skipping object of size zero')
   } else {
       // Download the logfile from S3, and upload to loggly.
       async.waterfall([
			function buckettags(next) {
			    var params = {
				Bucket: bucket /* required */
			    };

			    s3.getBucketTagging(params, function(err, data) {
				    if (err) { next(err); console.log(err, err.stack); } // an error occurred
				    else {
					var s3tag = _.zipObject(_.pluck(data['TagSet'], 'Key'),
									_.pluck(data['TagSet'], 'Value'));

					if (s3tag[BUCKET_LOGGLY_TOKEN_NAME]) {
					    LOGGLY_URL = LOGGLY_URL_BASE + s3tag[BUCKET_LOGGLY_TOKEN_NAME];
					    
					    if ( s3tag[BUCKET_LOGGLY_TAG_NAME] ) {
						LOGGLY_URL += '/tag/' + s3tag[BUCKET_LOGGLY_TAG_NAME];
					    }
					} else {
					    LOGGLY_URL = DEFAULT_LOGGLY_URL
					}
				    }
				    
				    if ( LOGGLY_URL ) next();
				    else next('No Loggly customer token. Set S3 bucket tag ' + BUCKET_LOGGLY_TOKEN_NAME)
			   });
			},

			function download(next) {
			    // Download the image from S3 into a buffer.
			    s3.getObject({
				    Bucket: bucket,
				    Key: key
				},
				next);
			},

			function upload(data, next) {
			    // Stream the logfile to loggly.
			    
			    var csvToJson = csv({objectMode: true, delimiter: ' '})
			    var parser = new Transform({objectMode: true})
			    parser._transform = parse_s3_log
			    var jsonToStrings = JSONStream.stringify(false)
			    var bufferStream = new Transform();

			    bufferStream.push(data.Body)
			    bufferStream.end()

			    console.log( 'Using Loggly endpoint: ' + LOGGLY_URL )

			    bufferStream
			     .pipe(csvToJson)
			     .pipe(parser)
			     .pipe(jsonToStrings)
			     .pipe(request.post(LOGGLY_URL)).on('error', function(err) {next(err)}).on('end', function() {next()})
			}
			], function (err) {
			   if (err) {
			       console.error(
					     'Unable to read ' + bucket + '/' + key +
					     ' and upload to loggly' +
					     ' due to an error: ' + err
					     );
			   } else {
			       console.log(
					   'Successfully uploaded ' + bucket + '/' + key +
					   ' to ' + LOGGLY_URL
					   );
			   }

			   context.done();
		       }
		       );
   }
};
