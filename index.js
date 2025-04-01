const Manager = require('./src/Manager');
const Constants = require('./src/Constants');

module.exports = {
    Manager,
    Constants,
    // Expose other classes if direct interaction is desired, but Manager should be the primary entry point
    // Node: require('./src/Node'),
    // Player: require('./src/Player'),
    // Queue: require('./src/Queue'),
};
