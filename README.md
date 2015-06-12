# elb2loggly
A Node.js AWS Lambda script that converts the ELB logs written to S3 into JSON and push them to Loggly

# More information about AWS Lambda
http://aws.amazon.com/lambda/

## Get the code and prep it for the uploading to AWS
1. Clone the git repo
```bash
git clone https://github.com/cboscolo/elb2loggly.git
cd elb2loggly
```
2. Optionally, edit elb2loggly.js with proper Loggly customer token and optional log tags. (You can set these as tags on the S3 Bucket that contains the logs.)
3. Install require npm packages.
```
npm install
```
4. zip up your code
```
zip -r elb2loggly.zip elb2loggly.js node_modules
```
The resulting zip (elb2loggly.zip) is what you will upload to AWS in step 4 below.

## Setting up AWS
For all of the AWS setup, I used the AWS console following [this example](http://docs.aws.amazon.com/lambda/latest/dg/getting-started-amazons3-events.html).  Below, you will find a high-level description of how to do this.  I also found [this blog post](http://alestic.com/2014/11/aws-lambda-cli) on how to set things up using the command line.

### Create and upload the elb2loggly Lamba function in the AWS Console
1. Create lambda function
  1. https://console.aws.amazon.com/lambda/home
  2. Click "Create a Lambda function" button. *(Choose "Upload a .ZIP file")*
    * Name: *elb2loggly*
    * Upload lambda function (zip file you made above.)
    * Handler*: elb2loggly.handler
    * Role*: In the drop down click "S3 execution role". (This will open a new window to create the role, click Allow)
    * I left the memory at 128MB.  In my testing with ELBs set upload every 5 minutes this worked for me.  You may need to bump this up if your ELB logs are larger.  
    * Same advice for Timer, I set it to 10 seconds.
2. Configure Event Source to call elb2loggly when logs added to S3 bucket.
  1. https://console.aws.amazon.com/lambda/home
  2. Make sure the elb2loggly lambda function is selected, then click 'Actions->Add event source'
    * Event source type: S3
    * Bucket: Choose the bucket that contains your ELB logs.
    * Event type: Put

### Configure the S3 buckets with tags the elb2loggly uses to know where to send logs.
Using S3 Management Console click the bucket that contains your ELB logs.
1. Under Properties -> Tags add the following tag:
  * **Key:** loggly-customer-token
  * **Value:** *your-loggly-customer-token*
2. And optionally this tag:
  * **Key:** loggly-tag
  * **Value:** *aws-elb* (Or what ever you want.)

### Configure ELB to log to S3
I'll assume you already have your ELB set up, just not logging.
  1. Goto the EC2 Management Console under 'Load Balancers'
  2. Choose your ELB, and scroll down to **Access Logs:**, click edit.
    * Set Interval to 5 minutes
    * Set **S3 Location** to the bucket where you want to put your logs.
