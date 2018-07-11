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

describe('storage/iam', function() {
  let Iam;
  let iam;

  let BUCKET_INSTANCE;
  let promisified = false;
  const fakeUtil = extend({}, util, {
    promisifyAll: function(Class) {
      if (Class.name === 'Iam') {
        promisified = true;
      }
    },
  });

  before(function() {
    Iam = proxyquire('../src/iam.js', {
      '@google-cloud/common': {
        util: fakeUtil,
      },
    }).Iam;
  });

  beforeEach(function() {
    BUCKET_INSTANCE = {
      id: 'bucket-id',
      request: util.noop,
    };

    iam = new Iam(BUCKET_INSTANCE);
  });

  describe('initialization', function() {
    it('should promisify all the things', function() {
      assert(promisified);
    });

    it('should localize the request function', function(done) {
      BUCKET_INSTANCE.request = function(callback) {
        assert.strictEqual(this, BUCKET_INSTANCE);
        callback(); // done()
      };

      const iam = new Iam(BUCKET_INSTANCE);
      iam.request_(done);
    });

    it('should localize the resource ID', function() {
      assert.strictEqual(iam.resourceId_, 'buckets/' + BUCKET_INSTANCE.id);
    });
  });

  describe('getPolicy', function() {
    it('should make the correct api request', function(done) {
      iam.request_ = function(reqOpts, callback) {
        assert.deepEqual(reqOpts, {
          uri: '/iam',
          qs: {},
        });

        callback(); // done()
      };

      iam.getPolicy(done);
    });

    it('should accept an options object', function(done) {
      const options = {
        userProject: 'grape-spaceship-123',
      };

      iam.request_ = function(reqOpts) {
        assert.strictEqual(reqOpts.qs, options);
        done();
      };

      iam.getPolicy(options, assert.ifError);
    });
  });

  describe('setPolicy', function() {
    it('should throw an error if a policy is not supplied', function() {
      assert.throws(function() {
        iam.setPolicy(util.noop);
      }, /A policy object is required\./);
    });

    it('should make the correct API request', function(done) {
      const policy = {
        a: 'b',
      };

      iam.request_ = function(reqOpts, callback) {
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

    it('should accept an options object', function(done) {
      const policy = {
        a: 'b',
      };

      const options = {
        userProject: 'grape-spaceship-123',
      };

      iam.request_ = function(reqOpts) {
        assert.strictEqual(reqOpts.qs, options);
        done();
      };

      iam.setPolicy(policy, options, assert.ifError);
    });
  });

  describe('testPermissions', function() {
    it('should throw an error if permissions are missing', function() {
      assert.throws(function() {
        iam.testPermissions(util.noop);
      }, /Permissions are required\./);
    });

    it('should make the correct API request', function(done) {
      const permissions = 'storage.bucket.list';

      iam.request_ = function(reqOpts) {
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

    it('should send an error back if the request fails', function(done) {
      const permissions = ['storage.bucket.list'];
      const error = new Error('Error.');
      const apiResponse = {};

      iam.request_ = function(reqOpts, callback) {
        callback(error, apiResponse);
      };

      iam.testPermissions(permissions, function(err, permissions, apiResp) {
        assert.strictEqual(err, error);
        assert.strictEqual(permissions, null);
        assert.strictEqual(apiResp, apiResponse);
        done();
      });
    });

    it('should pass back a hash of permissions the user has', function(done) {
      const permissions = ['storage.bucket.list', 'storage.bucket.consume'];
      const apiResponse = {
        permissions: ['storage.bucket.consume'],
      };

      iam.request_ = function(reqOpts, callback) {
        callback(null, apiResponse);
      };

      iam.testPermissions(permissions, function(err, permissions, apiResp) {
        assert.ifError(err);
        assert.deepEqual(permissions, {
          'storage.bucket.list': false,
          'storage.bucket.consume': true,
        });
        assert.strictEqual(apiResp, apiResponse);

        done();
      });
    });

    it('should accept an options object', function(done) {
      const permissions = ['storage.bucket.list'];
      const options = {
        userProject: 'grape-spaceship-123',
      };

      const expectedQuery = extend(
        {
          permissions: permissions,
        },
        options
      );

      iam.request_ = function(reqOpts) {
        assert.deepEqual(reqOpts.qs, expectedQuery);
        done();
      };

      iam.testPermissions(permissions, options, assert.ifError);
    });
  });
});
