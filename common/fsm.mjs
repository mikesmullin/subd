/**
 * Simple FSM (Finite State Machine) implementation
 * 
 * Usage:
 *   const fsm = new FSM({
 *     'pause': 'pending,running -> paused',
 *     'resume': 'paused -> pending',
 *     'stop': 'pending,running,paused -> stopped',
 *   });
 *   
 *   const result = fsm.transition('running', 'pause');
 *   // { success: true, from: 'running', to: 'paused' }
 */
export class FSM {
  constructor(transitions) {
    this.transitions = new Map();
    
    for (const [action, rule] of Object.entries(transitions)) {
      const [fromStr, to] = rule.split('->').map(s => s.trim());
      const from = fromStr.split(',').map(s => s.trim());
      this.transitions.set(action, { from, to });
    }
  }

  /**
   * Attempt a state transition
   * @param {string} currentState - Current state
   * @param {string} action - Action to perform
   * @returns {{ success: boolean, from: string, to?: string, error?: string }}
   */
  transition(currentState, action) {
    const rule = this.transitions.get(action);
    
    if (!rule) {
      return { success: false, from: currentState, error: `Unknown action: ${action}` };
    }

    if (!rule.from.includes(currentState)) {
      return { 
        success: false, 
        from: currentState, 
        error: `Cannot ${action} from '${currentState}'. Valid: ${rule.from.join(', ')}` 
      };
    }

    return { success: true, from: currentState, to: rule.to };
  }

  /**
   * Get all valid actions from a given state
   */
  validActions(currentState) {
    const actions = [];
    for (const [action, rule] of this.transitions) {
      if (rule.from.includes(currentState)) {
        actions.push(action);
      }
    }
    return actions;
  }
}
