'use strict';

const asyncHandler = require('./asyncHandler');
const { sendDownstreamFailure, errorBody } = require('../failure');

function createAuthenticate({ client, config }) {
  return asyncHandler(async (req, res, next) => {
    const header = req.get('authorization');
    if (!header) {
      return res
        .status(401)
        .json(errorBody('MISSING_TOKEN', 'Authorization header must be "Bearer <token>"'));
    }

    try {
      const result = await client.request('auth-service', `${config.authUrl}/auth/verify`, {
        headers: { authorization: header },
        requestId: req.requestId,
      });
      req.user = result.body.user;
      return next();
    } catch (err) {
      return sendDownstreamFailure(res, err); // 401 from Auth passes through; outages become 502/504
    }
  });
}

module.exports = { createAuthenticate };