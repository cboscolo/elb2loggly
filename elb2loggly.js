var aws = require('aws-sdk');
var s3 = new aws.S3({apiVersion: '2006-03-01'});
var _ = require('lodash');
var async = require('async');
var request = require('request');
var Transform = require('stream').Transform;
var csv = require('csv-streamify');
var JSONStream = require('JSONStream');

// Set LOGGLY_TOKEN to your Loggly customer token. It will look something like this:
// LOGGLY_TOKEN = 'ea5058ee-d62d-4faa-8388-058646faa747'
// Preferably, you should set the tag 'loggly-customer-tag' on the S3 bucket.

// Optionally set a LOGGLY_TAG if you want to tag these logs in a certain way. For example:
// LOGGLY_TAG = 'aws-elb-logs'
// Preferably, you should set the 'loggly-tag' on the S3 bucket.

var LOGGLY_URL_BASE = 'https://logs-01.loggly.com/bulk/';
var BUCKET_LOGGLY_TOKEN_NAME = 'loggly-customer-token';
var BUCKET_LOGGLY_TAG_NAME = 'loggly-tag';
var BUCKET_LOGGLY_PRIVATE_URL_PARAMS_NAME = 'elb2loggly-private-url-params';

var LOGGLY_URL = null;
var DEFAULT_LOGGLY_URL = null;

/* eslint-disable no-undef */
if (typeof LOGGLY_TOKEN !== 'undefined') {
  DEFAULT_LOGGLY_URL = LOGGLY_URL_BASE + LOGGLY_TOKEN;

  if (typeof LOGGLY_TAG !== 'undefined') {
    DEFAULT_LOGGLY_URL += '/tag/' + LOGGLY_TAG;
  }
}
/* eslint-enable no-undef */

if (DEFAULT_LOGGLY_URL) {
  console.log('Loading elb2loggly, default Loggly endpoint: ' + DEFAULT_LOGGLY_URL);
} else {
  console.log(
    'Loading elb2loggly, NO default Loggly endpoint, must be set in bucket tag ' + BUCKET_LOGGLY_TOKEN_NAME);
}

// AWS logs contain the following fields: (Note: a couple are parsed from within the field.)
// http://docs.aws.amazon.com/ElasticLoadBalancing/latest/DeveloperGuide/access-log-collection.html
var COLUMNS = [
  'timestamp', // 0
  'elb', // 1
  'client_ip', // 2
  'client_port', // 3 - split from client
  'backend', // 4
  'backend_port', // 5
  'request_processing_time', // 6
  'backend_processing_time', // 7
  'response_processing_time', // 8
  'elb_status_code', // 9
  'backend_status_code', // 10
  'received_bytes', // 11
  'sent_bytes', // 12
  'request_method', // 13 - Split from request
  'request_url', // 14 - Split from request
  'request_query_params', // 15 - Split from request
  'user_agent', // 16
  'ssl_cipher', // 17
  'ssl_protocol' // 18
];

// The following column indexes will be turned into numbers so that
// we can filter within loggly
var NUMERIC_COL_INDEX = [
  6,
  7,
  8,
  11,
  12
];

// A counter for the total number of events parsed
var eventsParsed = 0;

// Private query parameters that should be removed/obscured from the URL
var PRIVATE_URL_PARAMS = [];
var PRIVATE_URL_PARAMS_MAX_LENGTH = [];

// Obscures the provided parameter in the URL
// Returns the URL with the provided parameter obscured
var obscureURLParameter = function(url, parameter, obscureLength) {
    // prefer to use l.search if you have a location/link object
  var urlparts = url.split('?');
  if (urlparts.length >= 2) {
    var prefix = encodeURIComponent(parameter) + '=';
    var pars = urlparts[1].split(/[&;]/g);

        // reverse iteration as may be destructive
    for (var i = pars.length; i-- > 0;) {
            // If the parameter starts with the encoded prefix
      if (pars[i].lastIndexOf(prefix, 0) !== -1) {
        if (obscureLength > 0 && pars[i].length > obscureLength) {
            // If the total length of of the parameter is greater than
            // obscureLength we only take the left most characters
          pars[i] = pars[i].substring(0, prefix.length + obscureLength) + "...";
        } else {
            // Otherwise we just remove the parameter
          pars.splice(i, 1);
        }
      }
    }

    url = urlparts[0] + '?' + pars.join('&');
  }

  return url;
};

// Parse elb log into component parts.
var parseS3Log = function(data, encoding, done) {
  var originalData = data;
  // If this is a HTTP load balander we get 12 fields
  // for HTTPs load balancers we get 15
  if (data.length === 12 || data.length === 15) {
      // Keep an easily boolean depending on the ELB type
    var isHTTP = data.length === 12;
      // If this is a HTTP ELB we need to get rid of the HTTPs fields in our COLUMNS array
    if (isHTTP) {
      COLUMNS.splice(16, 3);
    }

      // Split clientip:port and backendip:port at index 2,3
      // We need to be carefull here because of potential 5xx errors which may not include
      // backend:port
    if (data[3].indexOf(':') > -1) {
        // If the field contains a colon we perform the normal split to get ip and port
      data.splice(3, 1, data[3].split(':'));
    } else {
        // We may get here if there was a 5xx error
        // We will add 'dash' place holders for the missing data
        // This is common for Apache logs when a field is blank, it is also more consistent with
        // the original ELB data
      data.splice(3, 1, '-', '-');
    }

      // client:port
    data.splice(2, 1, data[2].split(':'));

      // Ensure the data is flat
    data = _.flatten(data);

      // Pull the method from the request.  (WTF on Amazon's decision to keep these as one string.)
      // This position depends on the type of ELB
    var initialRequestPosition = isHTTP ? data.length - 1 : data.length - 4;
    var urlMash = data[initialRequestPosition];
    data.splice(initialRequestPosition, 1);
      // Ensure the data is flat
    data = _.flatten(data);

      // Split the url, the 2 parameter gives us only the last 2
      // e.g. Split POST https://secure.echoboxapp.com:443/api/authtest HTTP/1.1
      // into [0] - POST, [1] - https://secure.echoboxapp.com:443/api/authtest
    urlMash = urlMash.split(' ', 2);
    var requestMethod = urlMash[0];
    var requestUrl = urlMash[1];

      // Remove any private URL query parameters
    _.each(PRIVATE_URL_PARAMS, function(paramToRemove, paramIndex) {
      requestUrl = obscureURLParameter(requestUrl, paramToRemove, PRIVATE_URL_PARAMS_MAX_LENGTH[paramIndex]);
    });

      // Strip the query parameters into a separate field if any exist
    var requestParams = "";
    if (requestUrl.indexOf('?') !== -1) {
      requestParams = requestUrl.substring(requestUrl.indexOf('?') + 1, requestUrl.length);
      requestUrl = requestUrl.substring(0, requestUrl.indexOf('?'));
    }

      // Add the url request back into data array at the original position
    data.splice(initialRequestPosition, 0, requestParams);
    data.splice(initialRequestPosition, 0, requestUrl);
    data.splice(initialRequestPosition, 0, requestMethod);
      // Ensure the data is flat
    data = _.flatten(data);

      // Parse the numeric columns to floats
    _.each(NUMERIC_COL_INDEX, function(colIndex) {
      data[colIndex] = parseFloat(data[colIndex]);
    });

    if (data.length === COLUMNS.length) {
      this.push(_.zipObject(COLUMNS, data));
      eventsParsed++;
    } else {
      /* eslint-disable camelcase */
      var errorLog = {
        timestamp: originalData[0],
        elb: originalData[1],
        elb_status_code: originalData[7],
        error: 'ELB log length: ' + originalData.length + ' did not match COLUMNS length ' + COLUMNS.length
      };
      /* eslint-enable camelcase */

      this.push(errorLog);
        // Log an error including the line that was excluded
      console.error('ELB log length ' + data.length + ' did not match COLUMNS length ' + COLUMNS.length + ". " + data.join(" "));
    }

    done();
  } else {
      // Record a useful error in the lambda logs that something was wrong with the input data
    done("Expecting 12 or 15 fields, actual fields " + data.length);
  }
};

exports.handler = function(event, context) {
   // A useful line for debugging, add a version number to see which version ran in lambda
  console.log('Running lambda event handler.');

   // Get the object from the event and show its content type
  var bucket = event.Records[0].s3.bucket.name;
  var key = event.Records[0].s3.object.key;
  var size = event.Records[0].s3.object.size;

  if (size === 0) {
    console.log('S3ToLoggly skipping object of size zero');
  } else {
       // Download the logfile from S3, and upload to loggly.
    async.waterfall([
      function buckettags(next) {
        var params = {
          Bucket: bucket /* required */
        };

        s3.getBucketTagging(params, function(err, data) {
          if (err) {
            next(err);
            console.log(err, err.stack);
          } else {
              // Get an array of bucket tags
            var s3tag = _.zipObject(_.map(data.TagSet, 'Key'),
             _.map(data.TagSet, 'Value'));

              // If the 'token' tag is set we use that
            if (s3tag[BUCKET_LOGGLY_TOKEN_NAME]) {
              LOGGLY_URL = LOGGLY_URL_BASE + s3tag[BUCKET_LOGGLY_TOKEN_NAME];

                // If the 'loggly tag' tag is set we use that
              if (s3tag[BUCKET_LOGGLY_TAG_NAME]) {
                LOGGLY_URL += '/tag/' + s3tag[BUCKET_LOGGLY_TAG_NAME];
              }
            } else {
              LOGGLY_URL = DEFAULT_LOGGLY_URL;
            }
          }

            // If the 'private url params' tag set we parse that
          if (s3tag[BUCKET_LOGGLY_PRIVATE_URL_PARAMS_NAME]) {
              // First we split on double forward slash
            var privateParamEntries = s3tag[BUCKET_LOGGLY_PRIVATE_URL_PARAMS_NAME].split(/\/\//g);
            _.each(privateParamEntries, function(entry) {
                // The parameter name and max length is separated by a single forward slash
              var entrySplit = entry.split(/\//g);
              var paramName = entrySplit[0];
              var paramMaxLength = parseInt(entrySplit[1], 10);
              console.log('Private url parameter ' + paramName + ' will be obscured with max length ' + paramMaxLength + '.');
              PRIVATE_URL_PARAMS.push(paramName);
              PRIVATE_URL_PARAMS_MAX_LENGTH.push(paramMaxLength);
            });
          }

          if (LOGGLY_URL) {
            next();
          } else {
            next('No Loggly customer token. Set S3 bucket tag ' + BUCKET_LOGGLY_TOKEN_NAME);
          }
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

        var csvToJson = csv({objectMode: true, delimiter: ' '});
        var parser = new Transform({objectMode: true});
        parser._transform = parseS3Log;
        var jsonToStrings = JSONStream.stringify(false);
        var bufferStream = new Transform();

        bufferStream.push(data.Body);
        bufferStream.end();

        console.log('Using Loggly endpoint: ' + LOGGLY_URL);

        bufferStream
         .pipe(csvToJson)
         .pipe(parser)
         .pipe(jsonToStrings)
         .pipe(request.post(LOGGLY_URL))
         .on('error', function(err) {
           next(err);
         }).on('end', function() {
           next();
         });
      }
    ], function(err) {
      if (err) {
        console.error(
            'Unable to read ' + bucket + '/' + key +
            ' and upload to loggly' +
            ' due to an error: ' + err
            );
        context.fail(err);
      } else {
        console.log(
            'Successfully uploaded ' + bucket + '/' + key +
            ' to ' + LOGGLY_URL + ". Parsed " + eventsParsed + " events."
            );
        context.done();
      }
    });
  }
};
