// Copyright 2020 Google LLC
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

/**
 * This application demonstrates how to perform basic operations on files with
 * the Google Cloud Storage API.
 *
 * For more information, see the README.md under /storage and the documentation
 * at https://cloud.google.com/storage/docs.
 */

function main(bucketName = 'my-bucket', filename = 'test.txt') {
  // [START storage_generate_post_policy_url_v4]
  /**
   * TODO(developer): Uncomment the following lines before running the sample.
   */
  // const bucketName = 'Name of a bucket, e.g. my-bucket';
  // const filename = 'File to access, e.g. file.txt';

  // Imports the Google Cloud client library
  const {Storage} = require('@google-cloud/storage');

  // Creates a client
  const storage = new Storage();

  async function generateV4SignedPolicy() {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file('test.txt');

    // These options will allow temporary uploading of a file
    // through an HTML form.
    const expires = Date.now() + 10 * 60 * 1000; //  10 minutes
    const options = {
      expires,
      fields: {'x-goog-meta-test': 'data'},
    };

    // Get a v4 signed policy for uploading file
    const [response] = await file.generateSignedPostPolicyV4(options);

    // Create an HTML form with the provided policy
    console.log(`<form action='${response.url}' method='POST' enctype="multipart/form-data">`);
    // Include all fields returned in the HTML form as they're required
    for (const name of Object.keys(response.fields)) {
      const value = response.fields[name];
      console.log(`  <input name='${name}' value='${value}' type='hidden'/>`);
    }
    console.log("  <input type='file' name='file'/>");
    console.log("  <input type='submit' value='Upload File' name='submit'/>");
    console.log("</form>");
  }

  generateV4SignedPolicy().catch(console.error);
  // [END storage_generate_post_policy_url_v4]
}
main(...process.argv.slice(2));
