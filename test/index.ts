/**
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import arrify from 'arrify';
import assert from 'assert';
import extend from 'extend';
import nodeutil from 'util';
import proxyquire from 'proxyquire';
import { Service, util } from '@google-cloud/common';

function FakeChannel() {
  this.calledWith_ = arguments;
}

function FakeService() {
  this.calledWith_ = arguments;
  Service.apply(this, arguments);
}

nodeutil.inherits(FakeService, Service);

let extended = false;
const fakePaginator = {
  extend(Class, methods) {
    if (Class.name !== 'Storage') {
      return;
    }

    methods = arrify(methods);
    assert.equal(Class.name, 'Storage');
    assert.deepEqual(methods, ['getBuckets']);
    extended = true;
  },
  streamify(methodName) {
    return methodName;
  },
};

let promisified = false;
const fakeUtil = extend({}, util, {
  promisifyAll(Class, options) {
    if (Class.name !== 'Storage') {
      return;
    }

    promisified = true;
    assert.deepEqual(options.exclude, ['bucket', 'channel']);
  },
});
const originalFakeUtil = extend(true, {}, fakeUtil);

describe('Storage', () => {
  const PROJECT_ID = 'project-id';
  let Storage;
  let storage;
  let Bucket;

  before(() => {
    Storage = proxyquire('../src', {
      '@google-cloud/common': {
        Service: FakeService,
        paginator: fakePaginator,
        util: fakeUtil,
      },
      './channel.js': { Channel: FakeChannel },
    });
    Bucket = Storage.Bucket;
  });

  beforeEach(() => {
    extend(fakeUtil, originalFakeUtil);
    storage = new Storage({ projectId: PROJECT_ID });
  });

  describe('instantiation', () => {
    it('should extend the correct methods', () => {
      assert(extended); // See `fakePaginator.extend`
    });

    it('should streamify the correct methods', () => {
      assert.strictEqual(storage.getBucketsStream, 'getBuckets');
    });

    it('should promisify all the things', () => {
      assert(promisified);
    });

    it('should work without new', () => {
      assert.doesNotThrow(() => {
        Storage({ projectId: PROJECT_ID });
      });
    });

    it('should inherit from Service', () => {
      assert(storage instanceof Service);

      const calledWith = storage.calledWith_[0];

      const baseUrl = 'https://www.googleapis.com/storage/v1';
      assert.strictEqual(calledWith.baseUrl, baseUrl);
      assert.strictEqual(calledWith.projectIdRequired, false);
      assert.deepEqual(calledWith.scopes, [
        'https://www.googleapis.com/auth/iam',
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/devstorage.full_control',
      ]);
      assert.deepEqual(calledWith.packageJson, require('../../package.json'));
    });
  });

  describe('bucket', () => {
    it('should throw if no name was provided', () => {
      assert.throws(() => {
        storage.bucket();
      }, /A bucket name is needed to use Cloud Storage\./);
    });

    it('should accept a string for a name', () => {
      const newBucketName = 'new-bucket-name';
      const bucket = storage.bucket(newBucketName);
      assert(bucket instanceof Bucket);
      assert.equal(bucket.name, newBucketName);
    });

    it('should optionally accept options', () => {
      const options = {
        userProject: 'grape-spaceship-123',
      };

      const bucket = storage.bucket('bucket-name', options);
      assert.strictEqual(bucket.userProject, options.userProject);
    });
  });

  describe('channel', () => {
    const ID = 'channel-id';
    const RESOURCE_ID = 'resource-id';

    it('should create a Channel object', () => {
      const channel = storage.channel(ID, RESOURCE_ID);

      assert(channel instanceof FakeChannel);

      assert.strictEqual(channel.calledWith_[0], storage);
      assert.strictEqual(channel.calledWith_[1], ID);
      assert.strictEqual(channel.calledWith_[2], RESOURCE_ID);
    });
  });

  describe('createBucket', () => {
    const BUCKET_NAME = 'new-bucket-name';
    const METADATA = { a: 'b', c: { d: 'e' } };
    const BUCKET = { name: BUCKET_NAME };

    it('should make correct API request', done => {
      storage.request = (reqOpts, callback) => {
        assert.strictEqual(reqOpts.method, 'POST');
        assert.strictEqual(reqOpts.uri, '/b');
        assert.strictEqual(reqOpts.qs.project, storage.projectId);
        assert.strictEqual(reqOpts.json.name, BUCKET_NAME);

        callback();
      };

      storage.createBucket(BUCKET_NAME, done);
    });

    it('should accept a name, metadata, and callback', done => {
      storage.request = (reqOpts, callback) => {
        assert.deepEqual(reqOpts.json, extend(METADATA, { name: BUCKET_NAME }));
        callback(null, METADATA);
      };
      storage.bucket = name => {
        assert.equal(name, BUCKET_NAME);
        return BUCKET;
      };
      storage.createBucket(BUCKET_NAME, METADATA, err => {
        assert.ifError(err);
        done();
      });
    });

    it('should accept a name and callback only', done => {
      storage.request = (reqOpts, callback) => {
        callback();
      };
      storage.createBucket(BUCKET_NAME, done);
    });

    it('should throw if no name is provided', () => {
      assert.throws(() => {
        storage.createBucket();
      }, /A name is required to create a bucket\./);
    });

    it('should honor the userProject option', done => {
      const options = {
        userProject: 'grape-spaceship-123',
      };

      storage.request = reqOpts => {
        assert.strictEqual(reqOpts.qs.userProject, options.userProject);
        done();
      };

      storage.createBucket(BUCKET_NAME, options, assert.ifError);
    });

    it('should execute callback with bucket', done => {
      storage.bucket = () => {
        return BUCKET;
      };
      storage.request = (reqOpts, callback) => {
        callback(null, METADATA);
      };
      storage.createBucket(BUCKET_NAME, (err, bucket) => {
        assert.ifError(err);
        assert.deepEqual(bucket, BUCKET);
        assert.deepEqual(bucket.metadata, METADATA);
        done();
      });
    });

    it('should execute callback on error', done => {
      const error = new Error('Error.');
      storage.request = (reqOpts, callback) => {
        callback(error);
      };
      storage.createBucket(BUCKET_NAME, err => {
        assert.equal(err, error);
        done();
      });
    });

    it('should execute callback with apiResponse', done => {
      const resp = { success: true };
      storage.request = (reqOpts, callback) => {
        callback(null, resp);
      };
      storage.createBucket(BUCKET_NAME, (err, bucket, apiResponse) => {
        assert.equal(resp, apiResponse);
        done();
      });
    });

    describe('storage classes', () => {
      it('should expand metadata.coldline', done => {
        storage.request = reqOpts => {
          assert.strictEqual(reqOpts.json.storageClass, 'COLDLINE');
          done();
        };

        storage.createBucket(BUCKET_NAME, { coldline: true }, assert.ifError);
      });

      it('should expand metadata.dra', done => {
        storage.request = reqOpts => {
          const body = reqOpts.json;
          assert.strictEqual(body.storageClass, 'DURABLE_REDUCED_AVAILABILITY');
          done();
        };

        storage.createBucket(BUCKET_NAME, { dra: true }, assert.ifError);
      });

      it('should expand metadata.multiRegional', done => {
        storage.request = reqOpts => {
          assert.strictEqual(reqOpts.json.storageClass, 'MULTI_REGIONAL');
          done();
        };

        storage.createBucket(
          BUCKET_NAME,
          {
            multiRegional: true,
          },
          assert.ifError
        );
      });

      it('should expand metadata.nearline', done => {
        storage.request = reqOpts => {
          assert.strictEqual(reqOpts.json.storageClass, 'NEARLINE');
          done();
        };

        storage.createBucket(BUCKET_NAME, { nearline: true }, assert.ifError);
      });

      it('should expand metadata.regional', done => {
        storage.request = reqOpts => {
          assert.strictEqual(reqOpts.json.storageClass, 'REGIONAL');
          done();
        };

        storage.createBucket(BUCKET_NAME, { regional: true }, assert.ifError);
      });
    });

    describe('requesterPays', () => {
      it('should accept requesterPays setting', done => {
        const options = {
          requesterPays: true,
        };
        storage.request = reqOpts => {
          assert.deepStrictEqual(reqOpts.json.billing, options);
          assert.strictEqual(reqOpts.json.requesterPays, undefined);
          done();
        };
        storage.createBucket(BUCKET_NAME, options, assert.ifError);
      });
    });
  });

  describe('getBuckets', () => {
    it('should get buckets without a query', done => {
      storage.request = reqOpts => {
        assert.strictEqual(reqOpts.uri, '/b');
        assert.deepEqual(reqOpts.qs, { project: storage.projectId });
        done();
      };
      storage.getBuckets(util.noop);
    });

    it('should get buckets with a query', done => {
      const token = 'next-page-token';
      storage.request = reqOpts => {
        assert.deepEqual(reqOpts.qs, {
          project: storage.projectId,
          maxResults: 5,
          pageToken: token,
        });
        done();
      };
      storage.getBuckets({ maxResults: 5, pageToken: token }, util.noop);
    });

    it('should execute callback with error', done => {
      const error = new Error('Error.');
      const apiResponse = {};

      storage.request = (reqOpts, callback) => {
        callback(error, apiResponse);
      };

      storage.getBuckets({}, (err, buckets, nextQuery, resp) => {
        assert.strictEqual(err, error);
        assert.strictEqual(buckets, null);
        assert.strictEqual(nextQuery, null);
        assert.strictEqual(resp, apiResponse);
        done();
      });
    });

    it('should return nextQuery if more results exist', () => {
      const token = 'next-page-token';
      storage.request = (reqOpts, callback) => {
        callback(null, { nextPageToken: token, items: [] });
      };
      storage.getBuckets({ maxResults: 5 }, (err, results, nextQuery) => {
        assert.equal(nextQuery.pageToken, token);
        assert.strictEqual(nextQuery.maxResults, 5);
      });
    });

    it('should return null nextQuery if there are no more results', () => {
      storage.request = (reqOpts, callback) => {
        callback(null, { items: [] });
      };
      storage.getBuckets({ maxResults: 5 }, (err, results, nextQuery) => {
        assert.strictEqual(nextQuery, null);
      });
    });

    it('should return Bucket objects', done => {
      storage.request = (reqOpts, callback) => {
        callback(null, { items: [{ id: 'fake-bucket-name' }] });
      };
      storage.getBuckets((err, buckets) => {
        assert.ifError(err);
        assert(buckets[0] instanceof Bucket);
        done();
      });
    });

    it('should return apiResponse', done => {
      const resp = { items: [{ id: 'fake-bucket-name' }] };
      storage.request = (reqOpts, callback) => {
        callback(null, resp);
      };
      storage.getBuckets((err, buckets, nextQuery, apiResponse) => {
        assert.deepEqual(resp, apiResponse);
        done();
      });
    });

    it('should populate returned Bucket object with metadata', done => {
      const bucketMetadata = {
        id: 'bucketname',
        contentType: 'x-zebra',
        metadata: {
          my: 'custom metadata',
        },
      };
      storage.request = (reqOpts, callback) => {
        callback(null, { items: [bucketMetadata] });
      };
      storage.getBuckets((err, buckets) => {
        assert.ifError(err);
        assert.deepEqual(buckets[0].metadata, bucketMetadata);
        done();
      });
    });
  });
});
