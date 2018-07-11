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

import assert from 'assert';
import async from 'async';
import extend from 'extend';
import proxyquire from 'proxyquire';
import { util } from '@google-cloud/common';

let Acl;
describe('storage/acl', function() {
  let promisified = false;
  const fakeUtil = extend({}, util, {
    promisifyAll: function(Class) {
      if (Class.name === 'Acl') {
        promisified = true;
      }
    },
  });

  const Storage = require('../src');
  let acl;

  const ERROR = new Error('Error.');
  const MAKE_REQ = util.noop;
  const PATH_PREFIX = '/acl';
  const ROLE = Storage.acl.OWNER_ROLE;
  const ENTITY = 'user-user@example.com';

  before(function() {
    Acl = proxyquire('../src/acl.js', {
      '@google-cloud/common': {
        util: fakeUtil,
      },
    });
  });

  beforeEach(function() {
    acl = new Acl({request: MAKE_REQ, pathPrefix: PATH_PREFIX});
  });

  describe('initialization', function() {
    it('should promisify all the things', function() {
      assert(promisified);
    });

    it('should assign makeReq and pathPrefix', function() {
      assert.strictEqual(acl.pathPrefix, PATH_PREFIX);
      assert.strictEqual(acl.request_, MAKE_REQ);
    });
  });

  describe('add', function() {
    it('should make the correct api request', function(done) {
      acl.request = function(reqOpts) {
        assert.strictEqual(reqOpts.method, 'POST');
        assert.strictEqual(reqOpts.uri, '');
        assert.deepEqual(reqOpts.json, {entity: ENTITY, role: ROLE});
        done();
      };

      acl.add({entity: ENTITY, role: ROLE}, assert.ifError);
    });

    it('should set the generation', function(done) {
      const options = {
        entity: ENTITY,
        role: ROLE,
        generation: 8,
      };

      acl.request = function(reqOpts) {
        assert.strictEqual(reqOpts.qs.generation, options.generation);
        done();
      };

      acl.add(options, assert.ifError);
    });

    it('should set the userProject', function(done) {
      const options = {
        entity: ENTITY,
        role: ROLE,
        userProject: 'grape-spaceship-123',
      };

      acl.request = function(reqOpts) {
        assert.strictEqual(reqOpts.qs.userProject, options.userProject);
        done();
      };

      acl.add(options, assert.ifError);
    });

    it('should execute the callback with an ACL object', function(done) {
      const apiResponse = {entity: ENTITY, role: ROLE};
      const expectedAclObject = {entity: ENTITY, role: ROLE};

      acl.makeAclObject_ = function(obj) {
        assert.deepEqual(obj, apiResponse);
        return expectedAclObject;
      };

      acl.request = function(reqOpts, callback) {
        callback(null, apiResponse);
      };

      acl.add({entity: ENTITY, role: ROLE}, function(err, aclObject) {
        assert.ifError(err);
        assert.deepEqual(aclObject, expectedAclObject);
        done();
      });
    });

    it('should execute the callback with an error', function(done) {
      acl.request = function(reqOpts, callback) {
        callback(ERROR);
      };

      acl.add({entity: ENTITY, role: ROLE}, function(err) {
        assert.deepEqual(err, ERROR);
        done();
      });
    });

    it('should execute the callback with apiResponse', function(done) {
      const resp = {success: true};

      acl.request = function(reqOpts, callback) {
        callback(null, resp);
      };

      acl.add({entity: ENTITY, role: ROLE}, function(err, acls, apiResponse) {
        assert.deepEqual(resp, apiResponse);
        done();
      });
    });
  });

  describe('delete', function() {
    it('should make the correct api request', function(done) {
      acl.request = function(reqOpts) {
        assert.strictEqual(reqOpts.method, 'DELETE');
        assert.strictEqual(reqOpts.uri, '/' + encodeURIComponent(ENTITY));

        done();
      };

      acl.delete({entity: ENTITY}, assert.ifError);
    });

    it('should set the generation', function(done) {
      const options = {
        entity: ENTITY,
        generation: 8,
      };

      acl.request = function(reqOpts) {
        assert.strictEqual(reqOpts.qs.generation, options.generation);
        done();
      };

      acl.delete(options, assert.ifError);
    });

    it('should set the userProject', function(done) {
      const options = {
        entity: ENTITY,
        role: ROLE,
        userProject: 'grape-spaceship-123',
      };

      acl.request = function(reqOpts) {
        assert.strictEqual(reqOpts.qs.userProject, options.userProject);
        done();
      };

      acl.delete(options, assert.ifError);
    });

    it('should execute the callback with an error', function(done) {
      acl.request = function(reqOpts, callback) {
        callback(ERROR);
      };

      acl.delete({entity: ENTITY}, function(err) {
        assert.deepEqual(err, ERROR);
        done();
      });
    });

    it('should execute the callback with apiResponse', function(done) {
      const resp = {success: true};

      acl.request = function(reqOpts, callback) {
        callback(null, resp);
      };

      acl.delete({entity: ENTITY}, function(err, apiResponse) {
        assert.deepEqual(resp, apiResponse);
        done();
      });
    });
  });

  describe('get', function() {
    describe('all ACL objects', function() {
      it('should make the correct API request', function(done) {
        acl.request = function(reqOpts) {
          assert.strictEqual(reqOpts.uri, '');

          done();
        };

        acl.get(assert.ifError);
      });

      it('should accept a configuration object', function(done) {
        const generation = 1;

        acl.request = function(reqOpts) {
          assert.strictEqual(reqOpts.qs.generation, generation);

          done();
        };

        acl.get({generation: generation}, assert.ifError);
      });

      it('should pass an array of acl objects to the callback', function(done) {
        const apiResponse = {
          items: [
            {entity: ENTITY, role: ROLE},
            {entity: ENTITY, role: ROLE},
            {entity: ENTITY, role: ROLE},
          ],
        };

        const expectedAclObjects = [
          {entity: ENTITY, role: ROLE},
          {entity: ENTITY, role: ROLE},
          {entity: ENTITY, role: ROLE},
        ];

        acl.makeAclObject_ = function(obj, index) {
          return expectedAclObjects[index];
        };

        acl.request = function(reqOpts, callback) {
          callback(null, apiResponse);
        };

        acl.get(function(err, aclObjects) {
          assert.ifError(err);
          assert.deepEqual(aclObjects, expectedAclObjects);
          done();
        });
      });
    });

    describe('ACL object for an entity', function() {
      it('should get a specific ACL object', function(done) {
        acl.request = function(reqOpts) {
          assert.strictEqual(reqOpts.uri, '/' + encodeURIComponent(ENTITY));

          done();
        };

        acl.get({entity: ENTITY}, assert.ifError);
      });

      it('should accept a configuration object', function(done) {
        const generation = 1;

        acl.request = function(reqOpts) {
          assert.strictEqual(reqOpts.qs.generation, generation);

          done();
        };

        acl.get({entity: ENTITY, generation: generation}, assert.ifError);
      });

      it('should set the userProject', function(done) {
        const options = {
          entity: ENTITY,
          userProject: 'grape-spaceship-123',
        };

        acl.request = function(reqOpts) {
          assert.strictEqual(reqOpts.qs.userProject, options.userProject);
          done();
        };

        acl.get(options, assert.ifError);
      });

      it('should pass an acl object to the callback', function(done) {
        const apiResponse = {entity: ENTITY, role: ROLE};
        const expectedAclObject = {entity: ENTITY, role: ROLE};

        acl.makeAclObject_ = function() {
          return expectedAclObject;
        };

        acl.request = function(reqOpts, callback) {
          callback(null, apiResponse);
        };

        acl.get({entity: ENTITY}, function(err, aclObject) {
          assert.ifError(err);
          assert.deepEqual(aclObject, expectedAclObject);
          done();
        });
      });
    });

    it('should execute the callback with an error', function(done) {
      acl.request = function(reqOpts, callback) {
        callback(ERROR);
      };

      acl.get(function(err) {
        assert.deepEqual(err, ERROR);
        done();
      });
    });

    it('should execute the callback with apiResponse', function(done) {
      const resp = {success: true};

      acl.request = function(reqOpts, callback) {
        callback(null, resp);
      };

      acl.get(function(err, acls, apiResponse) {
        assert.deepEqual(resp, apiResponse);
        done();
      });
    });
  });

  describe('update', function() {
    it('should make the correct API request', function(done) {
      acl.request = function(reqOpts) {
        assert.strictEqual(reqOpts.method, 'PUT');
        assert.strictEqual(reqOpts.uri, '/' + encodeURIComponent(ENTITY));
        assert.deepEqual(reqOpts.json, {role: ROLE});

        done();
      };

      acl.update({entity: ENTITY, role: ROLE}, assert.ifError);
    });

    it('should set the generation', function(done) {
      const options = {
        entity: ENTITY,
        role: ROLE,
        generation: 8,
      };

      acl.request = function(reqOpts) {
        assert.strictEqual(reqOpts.qs.generation, options.generation);
        done();
      };

      acl.update(options, assert.ifError);
    });

    it('should set the userProject', function(done) {
      const options = {
        entity: ENTITY,
        role: ROLE,
        userProject: 'grape-spaceship-123',
      };

      acl.request = function(reqOpts) {
        assert.strictEqual(reqOpts.qs.userProject, options.userProject);
        done();
      };

      acl.update(options, assert.ifError);
    });

    it('should pass an acl object to the callback', function(done) {
      const apiResponse = {entity: ENTITY, role: ROLE};
      const expectedAclObject = {entity: ENTITY, role: ROLE};

      acl.makeAclObject_ = function() {
        return expectedAclObject;
      };

      acl.request = function(reqOpts, callback) {
        callback(null, apiResponse);
      };

      acl.update({entity: ENTITY, role: ROLE}, function(err, aclObject) {
        assert.ifError(err);
        assert.deepEqual(aclObject, expectedAclObject);
        done();
      });
    });

    it('should execute the callback with an error', function(done) {
      acl.request = function(reqOpts, callback) {
        callback(ERROR);
      };

      acl.update({entity: ENTITY, role: ROLE}, function(err) {
        assert.deepEqual(err, ERROR);
        done();
      });
    });

    it('should execute the callback with apiResponse', function(done) {
      const resp = {success: true};

      acl.request = function(reqOpts, callback) {
        callback(null, resp);
      };

      const config = {entity: ENTITY, role: ROLE};
      acl.update(config, function(err, acls, apiResponse) {
        assert.deepEqual(resp, apiResponse);
        done();
      });
    });
  });

  describe('makeAclObject_', function() {
    it('should return an ACL object from an API response', function() {
      const projectTeam = {
        projectNumber: '283748374',
        team: 'awesome',
      };

      const apiResponse = {
        entity: ENTITY,
        role: ROLE,
        projectTeam: projectTeam,
        extra: 'ignored',
        things: true,
      };

      assert.deepEqual(acl.makeAclObject_(apiResponse), {
        entity: ENTITY,
        role: ROLE,
        projectTeam: projectTeam,
      });
    });
  });

  describe('request', function() {
    it('should make the correct request', function(done) {
      const uri = '/uri';

      const reqOpts = {
        uri: uri,
      };

      acl.request_ = function(reqOpts_, callback) {
        assert.strictEqual(reqOpts_, reqOpts);
        assert.strictEqual(reqOpts_.uri, PATH_PREFIX + uri);
        callback(); // done()
      };

      acl.request(reqOpts, done);
    });
  });
});

describe('storage/AclRoleAccessorMethods', function() {
  let aclEntity;

  beforeEach(function() {
    aclEntity = new Acl.AclRoleAccessorMethods();
  });

  describe('initialization', function() {
    it('should assign access methods for every role object', function() {
      const expectedApi = [
        'addAllAuthenticatedUsers',
        'deleteAllAuthenticatedUsers',

        'addAllUsers',
        'deleteAllUsers',

        'addDomain',
        'deleteDomain',

        'addGroup',
        'deleteGroup',

        'addProject',
        'deleteProject',

        'addUser',
        'deleteUser',
      ];

      const actualOwnersApi = Object.keys(aclEntity.owners);
      assert.deepEqual(actualOwnersApi, expectedApi);

      const actualReadersApi = Object.keys(aclEntity.readers);
      assert.deepEqual(actualReadersApi, expectedApi);

      const actualWritersApi = Object.keys(aclEntity.writers);
      assert.deepEqual(actualWritersApi, expectedApi);
    });
  });

  describe('_assignAccessMethods', function() {
    it('should call parent method', function(done) {
      const userName = 'email@example.com';
      const role = 'fakerole';

      aclEntity.add = function(options, callback) {
        assert.deepEqual(options, {
          entity: 'user-' + userName,
          role: role,
        });

        callback();
      };

      aclEntity.delete = function(options, callback) {
        assert.deepEqual(options, {
          entity: 'allUsers',
          role: role,
        });

        callback();
      };

      aclEntity._assignAccessMethods(role);

      async.parallel(
        [
          function(next) {
            // The method name should be in plural form. (fakeroles vs fakerole)
            aclEntity.fakeroles.addUser(userName, next);
          },
          function(next) {
            aclEntity.fakeroles.deleteAllUsers(next);
          },
        ],
        done
      );
    });

    it('should return the parent methods return value', function() {
      const fakeReturn = {};

      aclEntity.add = function() {
        return fakeReturn;
      };

      aclEntity._assignAccessMethods('fakerole');

      const value = aclEntity.fakeroles.addUser('email@example.com');
      assert.strictEqual(value, fakeReturn);
    });

    it('should not pass in the callback if undefined', function(done) {
      aclEntity.add = function() {
        assert.strictEqual(arguments.length, 1);
        done();
      };

      aclEntity._assignAccessMethods('fakerole');
      aclEntity.fakeroles.addUser('email@example.com', undefined);
    });

    it('should optionally accept options', function(done) {
      const fakeRole = 'fakerole';
      const fakeUser = 'email@example.com';
      const fakeOptions = {
        userProject: 'grape-spaceship-123',
      };

      const expectedOptions = extend(
        {
          entity: 'user-' + fakeUser,
          role: fakeRole,
        },
        fakeOptions
      );

      aclEntity.add = function(options) {
        assert.deepEqual(options, expectedOptions);
        done();
      };

      aclEntity._assignAccessMethods(fakeRole);
      aclEntity.fakeroles.addUser(fakeUser, fakeOptions, assert.ifError);
    });
  });
});
