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
//   title: Storage Combine files.
//   description: Combine multiple files into one new file.
//   usage: node composeFile.js <BUCKET_NAME> <FIRST_FILE_NAME> <SECOND_FILE_NAME> <DESTINATION_FILE_NAME>

function main(
  bucketName = 'my-bucket',
  firstFileName = 'file-one.txt',
  secondFileName = 'file-two.txt',
  destinationFileName = 'file-one-two.txt'
) {
  // [START storage_compose_file]
  /**
   * TODO(developer): Uncomment the following line before running the sample.
   */
  // const bucketName = 'Name of a bucket, e.g. my-bucket';
  // const firstFileName = 'Name of first file name, e.g. file-one.txt';
  // const secondFileName = 'Name of second file name, e.g. file-two.txt';
  // const destinationFileName = 'Name of destination file name, e.g. file-one-two.txt';

  // Imports the Google Cloud client library
  const {Storage} = require('@google-cloud/storage');

  // Creates a client
  const storage = new Storage();

  async function composeFile() {
    const bucket = storage.bucket(bucketName);
    const sources = [firstFileName, secondFileName];

    await bucket.combine(sources, destinationFileName);

    console.log(
      `New composite file ${destinationFileName} was created by combining ${firstFileName} and ${secondFileName}`
    );
  }

  composeFile().catch(console.error);
  // [END storage_compose_file]
}
process.on('unhandledRejection', err => {
  console.error(err.message);
  process.exitCode = 1;
});
main(...process.argv.slice(2));
