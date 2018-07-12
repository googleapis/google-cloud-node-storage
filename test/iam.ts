/**
 * Copyright 2017 Google Inc. All Rights Reserved.
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

import assert from 'assert';
import extend from 'extend';
import proxyquire from 'proxyquire';
import { util } from '@google-cloud/common';

describe('storage/iam', () => {
  let Iam;
  let iam;

  let BUCKET_INSTANCE;
  let promisified = false;
  const fakeUtil = extend({}, util, {
    promisifyAll(Class) {
      if (Class.name === 'Iam') {
        promisified = true;
      }
    },
  });

  before(() => {
    Iam = proxyquire('../src/iam.js', {
      '@google-cloud/common': {
        util: fakeUtil,
      },
    }).Iam;
  });

  beforeEach(() => {
    BUCKET_INSTANCE = {
      id: 'bucket-id',
      request: util.noop,
    };

    iam = new Iam(BUCKET_INSTANCE);
  });

  describe('initialization', () => {
    it('should promisify all the things', () => {
      assert(promisified);
    });

    it('should localize the request function', done => {
      extend(BUCKET_INSTANCE, {
        request(callback) {
          assert.strictEqual(this, BUCKET_INSTANCE);
          callback(); // done()
        },
      });

      const iam = new Iam(BUCKET_INSTANCE);
      iam.request_(done);
    });

    it('should localize the resource ID', () => {
      assert.strictEqual(iam.resourceId_, 'buckets/' + BUCKET_INSTANCE.id);
    });
  });

  describe('getPolicy', () => {
    it('should make the correct api request', done => {
      iam.request_ = (reqOpts, callback) => {
        assert.deepEqual(reqOpts, {
          uri: '/iam',
          qs: {},
        });

        callback(); // done()
      };

      iam.getPolicy(done);
    });

    it('should accept an options object', done => {
      const options = {
        userProject: 'grape-spaceship-123',
      };

      iam.request_ = reqOpts => {
        assert.strictEqual(reqOpts.qs, options);
        done();
      };

      iam.getPolicy(options, assert.ifError);
    });
  });

  describe('setPolicy', () => {
    it('should throw an error if a policy is not supplied', () => {
      assert.throws(() => {
        iam.setPolicy(util.noop);
      }, /A policy object is required\./);
    });

    it('should make the correct API request', done => {
      const policy = {
        a: 'b',
      };

      iam.request_ = (reqOpts, callback) => {
        assert.deepEqual(reqOpts, {
          method: 'PUT',
          uri: '/iam',
          json: extend(
            {
              resourceId: iam.resourceId_,
            },
            policy
          ),
          qs: {},
        });

        callback(); // done()
      };

      iam.setPolicy(policy, done);
    });

    it('should accept an options object', done => {
      const policy = {
        a: 'b',
      };

      const options = {
        userProject: 'grape-spaceship-123',
      };

      iam.request_ = reqOpts => {
        assert.strictEqual(reqOpts.qs, options);
        done();
      };

      iam.setPolicy(policy, options, assert.ifError);
    });
  });

  describe('testPermissions', () => {
    it('should throw an error if permissions are missing', () => {
      assert.throws(() => {
        iam.testPermissions(util.noop);
      }, /Permissions are required\./);
    });

    it('should make the correct API request', done => {
      const permissions = 'storage.bucket.list';

      iam.request_ = reqOpts => {
        assert.deepEqual(reqOpts, {
          uri: '/iam/testPermissions',
          qs: {
            permissions: [permissions],
          },
          useQuerystring: true,
        });

        done();
      };

      iam.testPermissions(permissions, assert.ifError);
    });

    it('should send an error back if the request fails', done => {
      const permissions = ['storage.bucket.list'];
      const error = new Error('Error.');
      const apiResponse = {};

      iam.request_ = (reqOpts, callback) => {
        callback(error, apiResponse);
      };

      iam.testPermissions(permissions, (err, permissions, apiResp) => {
        assert.strictEqual(err, error);
        assert.strictEqual(permissions, null);
        assert.strictEqual(apiResp, apiResponse);
        done();
      });
    });

    it('should pass back a hash of permissions the user has', done => {
      const permissions = ['storage.bucket.list', 'storage.bucket.consume'];
      const apiResponse = {
        permissions: ['storage.bucket.consume'],
      };

      iam.request_ = (reqOpts, callback) => {
        callback(null, apiResponse);
      };

      iam.testPermissions(permissions, (err, permissions, apiResp) => {
        assert.ifError(err);
        assert.deepEqual(permissions, {
          'storage.bucket.list': false,
          'storage.bucket.consume': true,
        });
        assert.strictEqual(apiResp, apiResponse);

        done();
      });
    });

    it('should accept an options object', done => {
      const permissions = ['storage.bucket.list'];
      const options = {
        userProject: 'grape-spaceship-123',
      };

      const expectedQuery = extend(
        {
          permissions,
        },
        options
      );

      iam.request_ = reqOpts => {
        assert.deepEqual(reqOpts.qs, expectedQuery);
        done();
      };

      iam.testPermissions(permissions, options, assert.ifError);
    });
  });
});
