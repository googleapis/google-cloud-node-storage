// Copyright 2019 Google LLC
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

const {Storage} = require('@google-cloud/storage');
const {assert} = require('chai');
const {after, it} = require('mocha');
const cp = require('child_process');
const uuid = require('uuid');

const execSync = cmd => cp.execSync(cmd, {encoding: 'utf-8'});

const storage = new Storage();
const bucketName = `nodejs-storage-samples-${uuid.v4()}`;
const defaultKmsKeyName = process.env.GOOGLE_CLOUD_KMS_KEY_ASIA;
const bucket = storage.bucket(bucketName);

after(async () => {
  return bucket.delete().catch(console.error);
});

it('should create a bucket', async () => {
  const output = execSync(`node createNewBucket.js ${bucketName}`);
  assert.match(output, new RegExp(`Bucket ${bucketName} created.`));
  const [exists] = await bucket.exists();
  assert.strictEqual(exists, true);
});

it('should list buckets', () => {
  const output = execSync('node listBuckets.js');
  assert.match(output, /Buckets:/);
  assert.match(output, new RegExp(bucketName));
});

it('should get bucket metadata', async () => {
  const output = execSync(`node bucketMetadata.js ${bucketName}`);
  assert.include(output, bucketName);
});

it('should set a buckets default KMS key', async () => {
  const output = execSync(
    `node enableDefaultKMSKey.js ${bucketName} ${defaultKmsKeyName}`
  );
  assert.include(
    output,
    `Default KMS key for ${bucketName} was set to ${defaultKmsKeyName}.`
  );
  const metadata = await bucket.getMetadata();
  assert.strictEqual(
    metadata[0].encryption.defaultKmsKeyName,
    defaultKmsKeyName
  );
});

it("should enable a bucket's uniform bucket-level access", async () => {
  const output = execSync(
    `node enableUniformBucketLevelAccess.js ${bucketName}`
  );
  assert.match(
    output,
    new RegExp(`Uniform bucket-level access was enabled for ${bucketName}.`)
  );

  const metadata = await bucket.getMetadata();
  assert.strictEqual(
    metadata[0].iamConfiguration.uniformBucketLevelAccess.enabled,
    true
  );
});

it("should get a bucket's uniform bucket-level access metadata", async () => {
  const output = execSync(`node getUniformBucketLevelAccess.js ${bucketName}`);

  assert.match(
    output,
    new RegExp(`Uniform bucket-level access is enabled for ${bucketName}.`)
  );

  const [metadata] = await bucket.getMetadata();
  assert.ok(metadata.iamConfiguration.uniformBucketLevelAccess.enabled);
  assert.strictEqual(
    metadata.iamConfiguration.uniformBucketLevelAccess.lockedTime !== null,
    true
  );
});

it("should disable a bucket's uniform bucket-level access", async () => {
  const output = execSync(
    `node disableUniformBucketLevelAccess.js ${bucketName}`
  );
  assert.match(
    output,
    new RegExp(`Uniform bucket-level access was disabled for ${bucketName}.`)
  );

  const metadata = await bucket.getMetadata();
  assert.strictEqual(
    metadata[0].iamConfiguration.uniformBucketLevelAccess.enabled,
    false
  );
});

it('should configure a bucket cors', async () => {
  execSync(
    `node configureBucketCors.js ${bucketName} 3600 POST http://example.appspot.com content-type`
  );
  await bucket.getMetadata();
  assert.deepStrictEqual(bucket.metadata.cors[0], {
    origin: ['http://example.appspot.com'],
    method: ['POST'],
    responseHeader: ['content-type'],
    maxAgeSeconds: 3600,
  });
});

it('should remove a bucket cors configuration', async () => {
  const output = execSync(`node removeBucketCors.js ${bucketName}`);
  assert.include(
    output,
    `Removed CORS configuration from bucket ${bucketName}`
  );
  await bucket.getMetadata();
  assert.ok(!bucket.metadata.cors);
});

it("should enable a bucket's versioning", async () => {
  const output = execSync(`node enableBucketVersioning.js ${bucketName}`);
  assert.include(output, `Versioning is enabled for bucket ${bucketName}.`);
  await bucket.getMetadata();
  assert.strictEqual(bucket.metadata.versioning.enabled, true);
});

it("should disable a bucket's versioning", async () => {
  const output = execSync(`node disableBucketVersioning.js ${bucketName}`);
  assert.include(output, `Versioning is disabled for bucket ${bucketName}.`);
  await bucket.getMetadata();
  assert.strictEqual(bucket.metadata.versioning.enabled, false);
});

it('should add label to bucket', async () => {
  const output = execSync(
    `node addBucketLabel.js ${bucketName} labelone labelonevalue`
  );
  assert.include(output, `Added label to bucket ${bucketName}.`);
  const [labels] = await storage.bucket(bucketName).getLabels();
  assert.isTrue('labelone' in labels);
});

it('should remove label to bucket', async () => {
  const output = execSync(`node removeBucketLabel.js ${bucketName} labelone`);
  assert.include(output, `Removed labels from bucket ${bucketName}.`);
  const [labels] = await storage.bucket(bucketName).getLabels();
  assert.isFalse('labelone' in labels);
});

it('should delete a bucket', async () => {
  const output = execSync(`node deleteBucket.js ${bucketName}`);
  assert.match(output, new RegExp(`Bucket ${bucketName} deleted.`));
  const [exists] = await bucket.exists();
  assert.strictEqual(exists, false);
});
