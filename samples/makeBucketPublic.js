// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

// sample-metadata:
//   title: Storage Make Bucket Public.
//   description: Storage Make Bucket Public.
//   usage: node makeBucketPublic.js <BUCKET_NAME>

function main(bucketName = 'my-bucket') {
  // [START storage_set_bucket_public_iam]
  /**
   * TODO(developer): Uncomment the following lines before running the sample.
   */
  // const bucketName = 'Name of a bucket, e.g. my-bucket';

  // Imports the Google Cloud client library
  const {Storage} = require('@google-cloud/storage');

  // Creates a client
  const storage = new Storage();

  async function makeBucketPublic() {
    // Makes the bucket public
    await storage.bucket(bucketName).makePublic();

    console.log(`Bucket ${bucketName} is now publicly readable.`);
  }

  makeBucketPublic();
  // [END storage_set_bucket_public_iam]
}
process.on('unhandledRejection', err => {
  console.error(err.message);
  process.exitCode = 1;
});
main(...process.argv.slice(2));
