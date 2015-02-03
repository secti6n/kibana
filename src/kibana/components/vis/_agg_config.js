define(function (require) {
  return function AggConfigFactory(Private) {
    var _ = require('lodash');
    var fieldFormats = Private(require('components/index_patterns/_field_formats'));

    function AggConfig(vis, opts) {
      var self = this;

      self.id = String(opts.id || AggConfig.nextId(vis.aggs));
      self.vis = vis;
      self._opts = opts = (opts || {});

      // setters
      self.type = opts.type;
      self.schema = opts.schema;

      // resolve the params
      self.fillDefaults(opts.params);
    }

    /**
     * Ensure that all of the objects in the list have ids, the objects
     * and list are modified by reference.
     *
     * @param  {array[object]} list - a list of objects, objects can be anything really
     * @return {array} - the list that was passed in
     */
    AggConfig.ensureIds = function (list) {
      var have = [];
      var haveNot = [];
      list.forEach(function (obj) {
        (obj.id ? have : haveNot).push(obj);
      });

      var nextId = AggConfig.nextId(have);
      haveNot.forEach(function (obj) {
        obj.id = String(nextId++);
      });

      return list;
    };

    /**
     * Calculate the next id based on the ids in this list
     *
     * @return {array} list - a list of objects with id properties
     */
    AggConfig.nextId = function (list) {
      return 1 + list.reduce(function (max, obj) {
        return Math.max(max, +obj.id || 0);
      }, 0);
    };

    Object.defineProperties(AggConfig.prototype, {
      type: {
        get: function () {
          return this.__type;
        },
        set: function (type) {
          if (_.isString(type)) {
            type = AggConfig.aggTypes.byName[type];
          }

          if (type && _.isFunction(type.decorateAggConfig)) {
            type.decorateAggConfig(this);
          }

          this.__type = type;
        }
      },
      schema: {
        get: function () {
          return this.__schema;
        },
        set: function (schema) {
          if (_.isString(schema)) {
            schema = this.vis.type.schemas.all.byName[schema];
          }

          this.__schema = schema;
        }
      }
    });

    /**
     * Write the current values to this.params, filling in the defaults as we go
     *
     * @param  {object} [from] - optional object to read values from,
     *                         used when initializing
     * @return {undefined}
     */
    AggConfig.prototype.fillDefaults = function (from) {
      var self = this;
      from = from || self.params || {};
      var to = self.params = {};

      self.getAggParams().forEach(function (aggParam) {
        var val = from[aggParam.name];

        if (val == null) {
          if (aggParam.default == null) return;

          if (!_.isFunction(aggParam.default)) {
            val = aggParam.default;
          } else {
            val = aggParam.default(self);
            if (val == null) return;
          }
        }

        if (aggParam.deserialize) {
          var isTyped = _.isFunction(aggParam.type);

          var isType = isTyped && (val instanceof aggParam.type);
          var isObject = !isTyped && _.isObject(val);
          var isDeserialized = (isType || isObject);

          if (!isDeserialized) {
            val = aggParam.deserialize(val, self);
          }

          to[aggParam.name] = val;
          return;
        }

        to[aggParam.name] = _.cloneDeep(val);
      });
    };

    /**
     * Clear the parameters for this aggConfig
     *
     * @return {object} the new params object
     */
    AggConfig.prototype.resetParams = function () {
      // We need to ensure that row and field don't get overriden.
      return this.fillDefaults(_.pick(this.params, 'row', 'field'));
    };

    AggConfig.prototype.write = function () {
      return this.type.params.write(this);
    };

    AggConfig.prototype.createFilter = function (key) {
      if (!_.isFunction(this.type.createFilter)) {
        throw new TypeError('The "' + this.type.title + '" aggregation does not support filtering.');
      }

      var field = this.field();
      var label = this.fieldDisplayName();
      if (field && !field.filterable) {
        var message = 'The "' + label + '" field can not be used for filtering.';
        if (field.scripted) {
          message = 'The "' + label + '" field is scripted and can not be used for filtering.';
        }
        throw new TypeError(message);
      }

      return this.type.createFilter(this, key);
    };

    /**
     * Convert this aggConfig to it's dsl syntax.
     *
     * Adds params and adhoc subaggs to a pojo, then returns it
     *
     * @param  {AggConfig} aggConfig - the config object to convert
     * @return {void|Object} - if the config has a dsl representation, it is
     *                         returned, else undefined is returned
     */
    AggConfig.prototype.toDsl = function () {
      if (this.type.hasNoDsl) return;

      var self = this;
      self.type.params.forEach(function (param) {
        if (param.onRequest) {
          param.onRequest(self);
        }
      });

      var output = self.write();

      var configDsl = {};
      configDsl[self.type.name] = output.params;

      // if the config requires subAggs, write them to the dsl as well
      if (output.subAggs) {
        var subDslLvl = configDsl.aggs || (configDsl.aggs = {});
        output.subAggs.forEach(function nestAdhocSubAggs(subAggConfig) {
          subDslLvl[subAggConfig.id] = subAggConfig.toDsl();
        });
      }

      return configDsl;
    };

    AggConfig.prototype.toJSON = function () {
      var self = this;
      var params = self.params;

      var outParams = _.transform(self.getAggParams(), function (out, aggParam) {
        var val = params[aggParam.name];

        // don't serialize undefined/null values
        if (val == null) return;
        if (aggParam.serialize) val = aggParam.serialize(val, self);
        if (val == null) return;

        // to prevent accidental leaking, we will clone all complex values
        out[aggParam.name] = _.cloneDeep(val);
      }, {});

      return {
        id: self.id,
        type: self.type && self.type.name,
        schema: self.schema && self.schema.name,
        params: outParams
      };
    };

    AggConfig.prototype.getAggParams = function () {
      return [].concat(
        (this.type) ? this.type.params.raw : [],
        (this.schema) ? this.schema.params.raw : []
      );
    };

    AggConfig.prototype.getResponseAggs = function () {
      if (!this.type) return;
      return this.type.getResponseAggs(this) || [this];
    };

    AggConfig.prototype.getValue = function (bucket) {
      return this.type.getValue(this, bucket);
    };

    AggConfig.prototype.makeLabel = function () {
      if (!this.type) return '';
      return this.type.makeLabel(this);
    };

    AggConfig.prototype.field = function () {
      return this.params.field;
    };

    AggConfig.prototype.fieldFormatter = function () {
      if (this.schema && this.schema.group === 'metrics') {
        return fieldFormats.defaultByType.number.convert;
      }

      var field = this.field();
      return field ? field.format.convert : String;
    };

    AggConfig.prototype.fieldName = function () {
      var field = this.field();
      return field ? field.name : '';
    };

    AggConfig.prototype.fieldDisplayName = function () {
      var field = this.field();
      return field ? (field.displayName || this.fieldName()) : '';
    };

    return AggConfig;
  };
});
