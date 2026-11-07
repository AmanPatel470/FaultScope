'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { sendDownstreamFailure, errorBody } = require('../failure');
const { toCamel } = require('../caseConverter');

function createBlastRadiusRouter({ engine }) {
  const router = express.Router();

  router.get(
    '/graph',
    asyncHandler(async (req, res) => {
      try {
        const result = await engine.getGraph(req.requestId);
        return res.status(200).json(toCamel(result.body));
      } catch (err) {
        return sendDownstreamFailure(res, err);
      }
    })
  );

  router.post(
    '/analyze',
    asyncHandler(async (req, res) => {
      const failedService = req.body && req.body.failedService;
      const valid = typeof failedService === 'string' && failedService.length > 0 && failedService.length <= 64;
      if (!valid) {
        return res
          .status(400)
          .json(errorBody('VALIDATION_ERROR', 'failedService is required: a non-empty string of at most 64 characters'));
      }

      try {
        const result = await engine.analyze(failedService, req.requestId);
        return res.status(200).json(toCamel(result.body));
      } catch (err) {
        // Engine 404 (unknown service) passes through; outages become 502/504.
        return sendDownstreamFailure(res, err);
      }
    })
  );

  return router;
}

module.exports = { createBlastRadiusRouter };